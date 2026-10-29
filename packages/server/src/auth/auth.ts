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

/**
 * Access control. The server controls agents on this machine, so nothing talks to it without a
 * device session:
 * - `mintLinkToken` (CLI on start, `vibe-center link`) creates a short-lived, single-use token.
 *   Tokens live in memory only (a restart invalidates them) and are stored hashed.
 * - `exchange` trades a token for a long-lived device session: a random secret in an HttpOnly
 *   cookie; the devices table keeps only its SHA-256, so the DB can't be replayed.
 * - `authenticate` maps a cookie to its device; revoked devices are rejected.
 */
export class AuthService {
  private linkTokens = new Map<string, number>();

  constructor(
    private readonly repos: Repos,
    private readonly bus: EventBus,
  ) {}

  mintLinkToken(): string {
    const now = Date.now();
    for (const [hash, exp] of this.linkTokens) if (exp <= now) this.linkTokens.delete(hash);
    const token = randomToken();
    this.linkTokens.set(sha256(token), now + LINK_TOKEN_TTL_MS);
    return token;
  }

  exchange(
    token: string,
    deviceName: string | undefined,
    userAgent: string | null,
  ): { device: Device; secret: string } {
    const hash = sha256(token);
    const exp = this.linkTokens.get(hash);
    this.linkTokens.delete(hash);
    if (!exp || exp <= Date.now()) {
      throw new HttpError(
        401,
        "This link has expired or was already used. Run `vibe-center link` for a new one.",
      );
    }
    const secret = randomToken();
    const device = this.repos.devices.insert({
      id: newId(),
      name: deviceName?.trim() || deviceNameFromUa(userAgent),
      tokenHash: sha256(secret),
      userAgent,
    });
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
