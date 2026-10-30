import type { Device } from "@vibe-center/shared";
import { newId } from "../db/index.ts";
import type { Repos } from "../db/repos/index.ts";
import { HttpError } from "../domain/errors.ts";
import type { EventBus } from "../events/bus.ts";

export const SESSION_COOKIE = "vc_session";
/** Browsers cap cookie lifetime at 400 days. */
export const SESSION_MAX_AGE_S = 400 * 24 * 3600;
export const LINK_TOKEN_TTL_MS = 10 * 60_000;
const TOUCH_INTERVAL_MS = 60_000;
/** A device minting links from the UI (Settings → Devices → Add device) gets a few per minute. */
export const UI_LINK_RATE_LIMIT = 5;
const UI_LINK_RATE_WINDOW_MS = 60_000;

interface LinkRecord {
  /** Public reference for the mint response, `device.link.paired` and cancel; never sent in the link itself. */
  linkId: string;
  exp: number;
  /** Pre-assigned name from Settings → Add device, if any. */
  label: string | null;
  /** The device that minted it from the UI; null for CLI-minted links (`start`/`link`). */
  mintedBy: string | null;
}

/**
 * Access control. The server controls agents on this machine, so nothing talks to it without a
 * device session:
 * - `mintLinkToken` (CLI on start, `vibe-center link`) and `mintUiLink` (Settings → Devices, an
 *   existing device minting a link for a new one) create a short-lived, single-use token. Tokens
 *   live in memory only (a restart invalidates them) and are stored hashed.
 * - `exchange` trades a token for a long-lived device session: a random secret in an HttpOnly
 *   cookie; the devices table keeps only its SHA-256, so the DB can't be replayed.
 * - `authenticate` maps a cookie to its device; revoked devices are rejected.
 */
export class AuthService {
  private linkTokens = new Map<string, LinkRecord>();
  private uiMintAt = new Map<string, number[]>();

  constructor(
    private readonly repos: Repos,
    private readonly bus: EventBus,
  ) {}

  mintLinkToken(): string {
    return this.mint(null, null).token;
  }

  /** Throws 429 past `UI_LINK_RATE_LIMIT` per minute for this device. */
  mintUiLink(
    deviceId: string,
    label: string | undefined,
  ): { linkId: string; token: string; expiresAt: number } {
    const now = Date.now();
    const hits = (this.uiMintAt.get(deviceId) ?? []).filter((t) => now - t < UI_LINK_RATE_WINDOW_MS);
    if (hits.length >= UI_LINK_RATE_LIMIT) {
      throw new HttpError(429, "Too many links requested. Wait a minute and try again.");
    }
    hits.push(now);
    this.uiMintAt.set(deviceId, hits);
    const { linkId, token, exp } = this.mint(label?.trim() || null, deviceId);
    return { linkId, token, expiresAt: exp };
  }

  /** Revokes an outstanding link before it's used. 404 if it's already gone (used or expired). */
  cancelLink(linkId: string): void {
    for (const [hash, r] of this.linkTokens) {
      if (r.linkId === linkId) {
        this.linkTokens.delete(hash);
        return;
      }
    }
    throw new HttpError(404, "link not found or already used");
  }

  private mint(
    label: string | null,
    mintedBy: string | null,
  ): { linkId: string; token: string; exp: number } {
    const now = Date.now();
    for (const [hash, r] of this.linkTokens) if (r.exp <= now) this.linkTokens.delete(hash);
    const token = randomToken();
    const linkId = newId();
    const exp = now + LINK_TOKEN_TTL_MS;
    this.linkTokens.set(sha256(token), { linkId, exp, label, mintedBy });
    return { linkId, token, exp };
  }

  exchange(
    token: string,
    deviceName: string | undefined,
    userAgent: string | null,
  ): { device: Device; secret: string } {
    const hash = sha256(token);
    const record = this.linkTokens.get(hash);
    this.linkTokens.delete(hash);
    if (!record || record.exp <= Date.now()) {
      throw new HttpError(
        401,
        "This link has expired or was already used. Run `vibe-center link` for a new one.",
      );
    }
    const secret = randomToken();
    const device = this.repos.devices.insert({
      id: newId(),
      name: deviceName?.trim() || record.label || deviceNameFromUa(userAgent),
      tokenHash: sha256(secret),
      userAgent,
    });
    // Broadcast: `current` is relative to the publisher, not whoever receives the event.
    this.bus.publish({ type: "device.upsert", device: { ...device, current: false } });
    if (record.mintedBy) {
      this.bus.publish({
        type: "device.link.paired",
        linkId: record.linkId,
        device: { ...device, current: false },
      });
    }
    return { device: { ...device, current: true }, secret };
  }

  authenticate(secret: string | undefined): Device | null {
    if (!secret) return null;
    const device = this.repos.devices.byTokenHash(sha256(secret));
    if (!device) return null;
    if (Date.now() - device.lastSeenAt > TOUCH_INTERVAL_MS) this.repos.devices.touch(device.id);
    return { ...device, current: true };
  }

  listDevices(currentId: string): Device[] {
    return this.repos.devices.list(currentId);
  }

  rename(id: string, name: string, currentId: string): Device {
    if (!this.repos.devices.rename(id, name.trim())) throw new HttpError(404, "device not found");
    const device = this.repos.devices.get(id, currentId)!;
    this.bus.publish({ type: "device.upsert", device: { ...device, current: false } });
    return device;
  }

  revoke(id: string): void {
    if (!this.repos.devices.get(id)) throw new HttpError(404, "device not found");
    if (this.repos.devices.revoke(id)) this.bus.publish({ type: "device.revoked", deviceId: id });
  }
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export function sha256(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

function deviceNameFromUa(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os = /iPhone|iPad|Android|Mac OS X|Windows|Linux/.exec(ua)?.[0]?.replace("Mac OS X", "macOS") ?? "";
  const browser = /Edg|Firefox|Chrome|Safari/.exec(ua)?.[0]?.replace("Edg", "Edge") ?? "Browser";
  return os ? `${browser} on ${os}` : browser;
}
