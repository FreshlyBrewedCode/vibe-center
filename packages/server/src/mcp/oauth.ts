import { createHash, randomBytes } from "node:crypto";
import {
  buildDiscoveryUrls,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  InvalidClientError,
  InvalidGrantError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthMetadata,
  OAuthMetadataSchema,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { MCP_OAUTH_REDIRECT_PATH, type McpOAuthView } from "@vibe-center/shared";
import type { Repos } from "../db/repos/index.ts";
import type { McpServerRecord } from "../db/repos/mcp-servers.ts";
import { HttpError } from "../domain/errors.ts";
import { ToolError } from "./builtin/types.ts";

/**
 * Client side of the MCP Authorization spec (2026-07-28) for HTTP upstream servers, built from the
 * MCP SDK's primitives (discovery, registration, PKCE authorize URL, code exchange, refresh).
 * The SDK's `auth()` orchestrator isn't used: it mixes background refreshes with starting a
 * browser flow, and here those happen in different places (a tool call vs. a click in Settings,
 * on one device, with the result posted back by that device).
 *
 * - **Discovery:** an unauthenticated probe reads `WWW-Authenticate` (resource_metadata, scope);
 *   RFC 9728 resource metadata (required) names the authorization server; RFC 8414 / OIDC
 *   discovery gives its metadata, whose `issuer` must match. Every OAuth endpoint must be https
 *   (http only on loopback, for tests).
 * - **Client:** a pre-registered client id/secret from the server's settings, else a client
 *   registered dynamically (RFC 7591) and kept, bound to its issuer and redirect URI. Client ID
 *   metadata documents need a URL the authorization server can fetch, which a tailnet app
 *   doesn't have, so they aren't offered.
 * - **Flow:** authorization code + PKCE S256, `resource` (RFC 8707), `state` (single use, 10 min,
 *   bound to the device that started it), `iss` checked (RFC 9207), scopes from the challenge,
 *   else the resource metadata (plus `offline_access` when the server offers it).
 * - **Tokens** stay in `mcp_oauth`. `fetchFor` is the upstream transport's fetch: it adds the
 *   bearer token, refreshes ahead of expiry and on a 401 (one refresh at a time per server, as
 *   refresh tokens may rotate), and turns a dead grant into "needs sign-in".
 */

/** What `mcp_oauth.state` holds for one server. Secrets: never leaves the server. */
interface OAuthState {
  /** The authorization server's issuer, validated against its metadata. */
  issuer?: string;
  metadata?: AsMetadata;
  resource?: string;
  /** Dynamically registered client, bound to the issuer and redirect URI it was registered with. */
  client?: { info: OAuthClientInformationMixed; issuer: string; redirectUri: string };
  /** The issuer a pre-registered client id was first used with (it is specific to one server). */
  preregisteredIssuer?: string;
  tokens?: StoredTokens;
  account?: string | null;
  /** Scopes a 403 insufficient_scope challenge asked for; the next sign-in requests them too. */
  scopeHint?: string;
  /** `resource_name` from the resource metadata (e.g. "T3 Code"); null = it has none. */
  resourceName?: string | null;
}

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope?: string;
  expiresAt: number | null;
  issuer: string;
  /** The client the tokens were issued to (refresh needs the same one). */
  client: OAuthClientInformationMixed;
}

interface Flow {
  serverId: string;
  /** The server's URL when the flow started: a changed server doesn't get these tokens. */
  url: string;
  deviceId: string;
  redirectUri: string;
  codeVerifier: string;
  issuer: string;
  metadata: AsMetadata;
  client: OAuthClientInformationMixed;
  resource: string;
  scope: string | undefined;
  returnTo: string;
  popup: boolean;
  expiresAt: number;
}

export const FLOW_TTL_MS = 10 * 60_000;
const MAX_FLOWS = 50;
/** Refresh this long before the access token expires. */
const REFRESH_AHEAD_MS = 60_000;
const OAUTH_TIMEOUT_MS = 15_000;

/** A tool call or connection needs the user to sign in again; agents get this as the tool error. */
export class NeedsSignInError extends ToolError {
  constructor(serverName: string) {
    super(
      `The "${serverName}" MCP server needs sign-in. Ask the user to sign in under Settings → MCP servers, then try again.`,
    );
  }
}

export interface OAuthEvents {
  /** The server wants a (new) sign-in; `message` says why. */
  needsAuth(serverId: string, message: string): void;
  /** Stored connection info changed (tokens refreshed, signed in, disconnected). */
  changed(serverId: string): void;
}

/** RFC 8414 metadata, unknown fields kept (`authorization_response_iss_parameter_supported`, …). */
type AsMetadata = OAuthMetadata & { authorization_response_iss_parameter_supported?: boolean };

/**
 * RFC 8414 then OIDC discovery, in the spec's order (the SDK's URL list). Unlike the SDK's own
 * discovery this keeps every field of an OIDC document, so revocation and RFC 9207 support
 * aren't lost.
 */
async function discoverAsMetadata(asUrl: string): Promise<AsMetadata | undefined> {
  for (const { url } of buildDiscoveryUrls(asUrl)) {
    const res = await oauthFetch(url, {
      headers: { accept: "application/json", "mcp-protocol-version": LATEST_PROTOCOL_VERSION },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (res.status < 500) continue;
      throw new Error(`HTTP ${res.status} from ${url.href}`);
    }
    return OAuthMetadataSchema.parse(await res.json()) as AsMetadata;
  }
  return undefined;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https, or http on loopback (local test servers). */
export function secureUrl(url: string | URL): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
}

function requireSecure(url: string | URL | undefined, what: string): void {
  if (url !== undefined && !secureUrl(url)) {
    throw new HttpError(400, `the ${what} (${String(url)}) isn't https; refusing to use it for OAuth`);
  }
}

/** fetch for OAuth endpoints: https only (also after redirects), with a timeout. */
const oauthFetch: FetchLike = async (url, init) => {
  requireSecure(url, "OAuth endpoint");
  const res = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(OAUTH_TIMEOUT_MS) });
  if (res.url) requireSecure(res.url, "OAuth endpoint");
  return res;
};

/** The RFC 8414 rule (issuer identical to the one the metadata URL was built from); a lone trailing slash is tolerated, since it builds the same URL. */
function sameIssuer(a: string, b: string): boolean {
  return a === b || a.replace(/\/$/, "") === b.replace(/\/$/, "");
}

function union(...scopes: (string | undefined | null)[]): string | undefined {
  const all = new Set(scopes.flatMap((s) => (s ? s.split(/\s+/).filter(Boolean) : [])));
  return all.size ? [...all].join(" ") : undefined;
}

/** Who signed in, for display only (unverified): the ID token, else a JWT access token. */
function accountOf(tokens: OAuthTokens): string | null {
  for (const jwt of [tokens.id_token, tokens.access_token]) {
    const payload = jwt?.split(".")[1];
    if (!payload || jwt.split(".").length !== 3) continue;
    try {
      const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
      const v = c.email ?? c.preferred_username ?? c.name ?? c.sub;
      if (typeof v === "string" && v) return v.slice(0, 200);
    } catch {}
  }
  return null;
}

/** Whether a server's requests go through OAuth: HTTP, https (or loopback), no own Authorization header. */
export function usesOAuth(r: McpServerRecord): boolean {
  if (r.transport !== "http" || !r.url || !secureUrl(r.url)) return false;
  return !Object.keys(r.headers).some((k) => k.toLowerCase() === "authorization");
}

export class McpOAuth {
  /** sha256(state) → the flow it started. In memory: a restart cancels open sign-ins. */
  private flows = new Map<string, Flow>();
  private refreshing = new Map<string, Promise<StoredTokens>>();

  constructor(
    private readonly repos: Repos,
    private readonly events: OAuthEvents,
  ) {}

  private load(serverId: string): OAuthState {
    return this.repos.mcpOAuth.get<OAuthState>(serverId) ?? {};
  }

  private save(serverId: string, state: OAuthState): void {
    this.repos.mcpOAuth.set(serverId, state);
    this.events.changed(serverId);
  }

  // ---- what the UI sees -------------------------------------------------------------------------

  view(r: McpServerRecord): McpOAuthView | null {
    if (r.transport !== "http") return null;
    const s = this.load(r.id);
    const t = s.tokens;
    const secret = r.oauth?.clientSecret;
    return {
      clientId: r.oauth?.clientId ?? null,
      clientSecret: secret ? { hint: secret.length >= 12 ? secret.slice(-4) : "" } : null,
      scopes: r.oauth?.scopes ?? null,
      connected: !!t,
      account: t ? (s.account ?? null) : null,
      grantedScopes: t?.scope ? t.scope.split(/\s+/).filter(Boolean) : [],
      expiresAt: t?.expiresAt ?? null,
      refreshable: !!t?.refresh_token,
      expired: !!t && !t.refresh_token && t.expiresAt !== null && t.expiresAt < Date.now(),
      issuer: s.issuer ?? null,
      registration: r.oauth?.clientId ? "preregistered" : s.client ? "dynamic" : null,
      resourceName: s.resourceName ?? null,
      revocable: !!s.metadata?.revocation_endpoint,
    };
  }

  // ---- sign-in ----------------------------------------------------------------------------------

  /**
   * Discover, register if needed, and return the authorization URL for the browser. `origin` is
   * the app's origin as this device reaches it (the redirect page lives there, and so does the
   * device's session cookie).
   */
  async start(
    r: McpServerRecord,
    opts: { deviceId: string; origin: string; returnTo: string; popup: boolean },
  ): Promise<{ authorizationUrl: string; redirectUri: string }> {
    if (r.transport !== "http" || !r.url) throw new HttpError(400, "OAuth sign-in is for HTTP servers");
    if (!secureUrl(r.url)) throw new HttpError(400, "OAuth needs an https server URL");
    if (!usesOAuth(r)) {
      throw new HttpError(
        400,
        "this server sends its own Authorization header; remove it to sign in with OAuth",
      );
    }
    const redirectUri = new URL(MCP_OAUTH_REDIRECT_PATH, opts.origin).href;
    const state = this.load(r.id);

    // 1. The server's challenge (resource metadata URL, scopes), from an unauthenticated request.
    const challenge = await this.probe(r.url);

    // 2. Protected resource metadata (RFC 9728): required, it names the authorization server.
    let prm: Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>>;
    try {
      prm = await discoverOAuthProtectedResourceMetadata(
        r.url,
        { resourceMetadataUrl: challenge.resourceMetadataUrl },
        oauthFetch,
      );
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(
        502,
        `${r.name} publishes no OAuth protected resource metadata (RFC 9728): ${errorText(e)}. If it takes a token, add it as an Authorization header instead.`,
      );
    }
    if (!checkResourceAllowed({ requestedResource: r.url, configuredResource: prm.resource })) {
      throw new HttpError(502, `the resource metadata is for ${prm.resource}, not ${r.url}`);
    }
    const asUrl = prm.authorization_servers?.[0];
    if (!asUrl) throw new HttpError(502, `${r.name}'s resource metadata names no authorization server`);
    requireSecure(asUrl, "authorization server");

    // 3. Authorization server metadata (RFC 8414, then OIDC discovery); the issuer must match.
    let metadata: AsMetadata | undefined;
    try {
      metadata = await discoverAsMetadata(asUrl);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(
        502,
        `couldn't read the authorization server's metadata at ${asUrl}: ${errorText(e)}`,
      );
    }
    if (!metadata) throw new HttpError(502, `the authorization server ${asUrl} publishes no metadata`);
    if (!sameIssuer(metadata.issuer, asUrl)) {
      throw new HttpError(
        502,
        `the authorization server's metadata names issuer ${metadata.issuer}, not ${asUrl}`,
      );
    }
    const issuer = metadata.issuer;
    requireSecure(metadata.authorization_endpoint, "authorization endpoint");
    requireSecure(metadata.token_endpoint, "token endpoint");
    requireSecure(metadata.registration_endpoint, "registration endpoint");
    requireSecure(metadata.revocation_endpoint, "revocation endpoint");
    const methods = metadata.code_challenge_methods_supported;
    if (methods && !methods.includes("S256")) {
      throw new HttpError(502, "the authorization server doesn't support PKCE with S256");
    }

    // 4. Scopes: the user's override, else the challenge, else the resource metadata; plus what
    //    a step-up challenge asked for and offline_access (refresh tokens) when it's offered.
    const base = r.oauth?.scopes ?? challenge.scope ?? prm.scopes_supported?.join(" ");
    const offline = metadata.scopes_supported?.includes("offline_access") ? "offline_access" : undefined;
    const scope = union(base, state.scopeHint, base || state.scopeHint ? offline : undefined);

    // 5. The client: pre-registered, else the stored dynamic registration, else register now.
    let client: OAuthClientInformationMixed;
    const next: OAuthState = {
      ...state,
      issuer,
      metadata,
      resource: prm.resource,
      resourceName: typeof prm.resource_name === "string" ? prm.resource_name.slice(0, 100) : null,
    };
    if (r.oauth?.clientId) {
      if (state.preregisteredIssuer && state.preregisteredIssuer !== issuer) {
        throw new HttpError(
          409,
          `the client ID was used with ${state.preregisteredIssuer}, but ${r.name} now uses ${issuer}; check the client ID`,
        );
      }
      client = {
        client_id: r.oauth.clientId,
        ...(r.oauth.clientSecret ? { client_secret: r.oauth.clientSecret } : {}),
      };
    } else if (state.client && state.client.issuer === issuer && state.client.redirectUri === redirectUri) {
      client = state.client.info;
    } else if (metadata.registration_endpoint) {
      const info = await registerClient(asUrl, {
        metadata,
        clientMetadata: this.clientMetadata(redirectUri),
        scope,
        fetchFn: oauthFetch,
      }).catch((e) => {
        throw new HttpError(
          502,
          `dynamic client registration with ${issuer} failed: ${errorText(e)}. Register a client with redirect URI ${redirectUri} and enter its ID under the server's OAuth settings.`,
        );
      });
      client = info;
      next.client = { info, issuer, redirectUri };
    } else {
      throw new HttpError(
        400,
        `${issuer} doesn't offer dynamic client registration. Register a client there with redirect URI ${redirectUri} and enter its client ID under the server's OAuth settings.`,
      );
    }
    this.save(r.id, next);

    // 6. PKCE + state, and the URL to open.
    const stateValue = randomBytes(32).toString("base64url");
    const { authorizationUrl, codeVerifier } = await startAuthorization(asUrl, {
      metadata,
      clientInformation: client,
      redirectUrl: redirectUri,
      scope,
      state: stateValue,
      resource: prm.resource,
    });
    this.prune();
    this.flows.set(sha256(stateValue), {
      serverId: r.id,
      url: r.url,
      deviceId: opts.deviceId,
      redirectUri,
      codeVerifier,
      issuer,
      metadata,
      client,
      resource: prm.resource,
      scope,
      returnTo: opts.returnTo,
      popup: opts.popup,
      expiresAt: Date.now() + FLOW_TTL_MS,
    });
    return { authorizationUrl: authorizationUrl.href, redirectUri };
  }

  /** The redirect page posted what the authorization server sent back. Single use. */
  async complete(
    body: { state: string; code?: string; iss?: string; error?: string; errorDescription?: string },
    deviceId: string,
    currentRecord: (serverId: string) => McpServerRecord | null,
  ): Promise<{ serverId: string; returnTo: string; popup: boolean }> {
    const key = sha256(body.state);
    const flow = this.flows.get(key);
    this.flows.delete(key);
    if (!flow || flow.expiresAt < Date.now()) {
      throw new HttpError(400, "this sign-in expired or was already used; start it again", "settings:mcp");
    }
    if (flow.deviceId !== deviceId) {
      throw new HttpError(403, "this sign-in was started on another device", "settings:mcp");
    }
    // RFC 9207: a present `iss` must be the issuer the flow started with; one that advertises
    // `iss` must send it. On a mismatch nothing of the response (not even its error) is used.
    const issSupported = flow.metadata.authorization_response_iss_parameter_supported === true;
    if (body.iss !== undefined ? body.iss !== flow.issuer : issSupported) {
      throw new HttpError(
        400,
        "the response didn't come from the expected authorization server",
        "settings:mcp",
      );
    }
    if (body.error) {
      const why = body.errorDescription ? `${body.error}: ${body.errorDescription}` : body.error;
      throw new HttpError(400, `the authorization server refused: ${why}`.slice(0, 500), "settings:mcp");
    }
    if (!body.code) throw new HttpError(400, "no authorization code in the response", "settings:mcp");
    const r = currentRecord(flow.serverId);
    if (!r || r.url !== flow.url)
      throw new HttpError(409, "the server was changed or removed during the sign-in");

    let tokens: OAuthTokens;
    try {
      tokens = await exchangeAuthorization(flow.metadata.issuer, {
        metadata: flow.metadata,
        clientInformation: flow.client,
        authorizationCode: body.code,
        codeVerifier: flow.codeVerifier,
        redirectUri: flow.redirectUri,
        resource: flow.resource,
        fetchFn: oauthFetch,
      });
    } catch (e) {
      throw new HttpError(502, `exchanging the authorization code failed: ${errorText(e)}`, "settings:mcp");
    }
    const state = this.load(flow.serverId);
    this.save(flow.serverId, {
      ...state,
      issuer: flow.issuer,
      metadata: flow.metadata,
      resource: flow.resource,
      ...(r.oauth?.clientId ? { preregisteredIssuer: flow.issuer } : {}),
      tokens: this.stored(tokens, flow.issuer, flow.client, flow.scope),
      account: accountOf(tokens),
      scopeHint: undefined,
    });
    return { serverId: flow.serverId, returnTo: flow.returnTo, popup: flow.popup };
  }

  /** Revoke at the authorization server (RFC 7009, best effort) and forget the tokens. */
  async disconnect(r: McpServerRecord): Promise<void> {
    const state = this.load(r.id);
    const t = state.tokens;
    if (t && state.metadata?.revocation_endpoint) {
      for (const [token, hint] of [
        [t.refresh_token, "refresh_token"],
        [t.access_token, "access_token"],
      ] as const) {
        if (token)
          await this.revoke(state.metadata.revocation_endpoint, t.client, token, hint).catch(() => {});
      }
    }
    if (this.repos.mcpOAuth.get(r.id)) this.save(r.id, { ...state, tokens: undefined, account: undefined });
  }

  /** Forget everything (the URL or the client changed): the next sign-in starts from discovery. */
  reset(serverId: string): void {
    this.repos.mcpOAuth.delete(serverId);
    for (const [k, f] of this.flows) if (f.serverId === serverId) this.flows.delete(k);
  }

  private async revoke(
    endpoint: string,
    client: OAuthClientInformationMixed,
    token: string,
    hint: string,
  ): Promise<void> {
    const params = new URLSearchParams({ token, token_type_hint: hint });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (client.client_secret) {
      const basic = `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`;
      headers.authorization = `Basic ${Buffer.from(basic).toString("base64")}`;
    } else {
      params.set("client_id", client.client_id);
    }
    await oauthFetch(endpoint, { method: "POST", headers, body: params });
  }

  private clientMetadata(redirectUri: string): OAuthClientMetadata {
    const local = LOOPBACK.has(new URL(redirectUri).hostname);
    return {
      client_name: "Vibe Center",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      // OIDC servers check redirect URIs by application type: localhost is "native".
      application_type: local ? "native" : "web",
    } as OAuthClientMetadata;
  }

  private stored(
    tokens: OAuthTokens,
    issuer: string,
    client: OAuthClientInformationMixed,
    requested: string | undefined,
    previous?: StoredTokens,
  ): StoredTokens {
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? previous?.refresh_token,
      token_type: tokens.token_type,
      scope: tokens.scope ?? previous?.scope ?? requested,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
      issuer,
      client,
    };
  }

  /** An unauthenticated MCP initialize: the 401's `WWW-Authenticate` carries the hints. */
  private async probe(url: string): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "vibe-center", version: "1.0.0" },
          },
        }),
        signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => {});
      if (res.status !== 401) return {};
      const p = extractWWWAuthenticateParams(res);
      if (p.resourceMetadataUrl) requireSecure(p.resourceMetadataUrl, "resource metadata URL");
      return { resourceMetadataUrl: p.resourceMetadataUrl, scope: p.scope };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      return {};
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, f] of this.flows) if (f.expiresAt < now) this.flows.delete(k);
    while (this.flows.size >= MAX_FLOWS) this.flows.delete(this.flows.keys().next().value!);
  }

  // ---- using the tokens -------------------------------------------------------------------------

  /**
   * The fetch an OAuth-capable server's MCP transport uses (undefined: plain fetch). Sends the
   * bearer token, refreshes it ahead of expiry and after a 401, and throws `NeedsSignInError`
   * (after reporting `needs_auth`) when there's no usable grant.
   */
  fetchFor(r: McpServerRecord): FetchLike | undefined {
    if (!usesOAuth(r)) return undefined;
    const send = (url: string | URL, init: RequestInit | undefined, t: StoredTokens | undefined) => {
      const headers = new Headers(init?.headers);
      if (t) headers.set("authorization", `Bearer ${t.access_token}`);
      return fetch(url, { ...init, headers });
    };
    return async (url, init) => {
      let t = this.load(r.id).tokens;
      if (t && t.expiresAt !== null && t.expiresAt - REFRESH_AHEAD_MS < Date.now()) {
        // Without a refresh token (some servers issue none, e.g. T3 Code) an expired sign-in
        // just needs a new one; no point sending it.
        if (t.refresh_token) t = await this.refresh(r, t);
        else if (t.expiresAt < Date.now()) this.signInGone(r, "The sign-in expired. Sign in again.");
      }
      let res = await send(url, init, t);
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        if (t?.refresh_token) {
          t = await this.refresh(r, t);
          res = await send(url, init, t);
          if (res.status !== 401) return res;
          await res.body?.cancel().catch(() => {});
        }
        if (t) this.signInGone(r, "The sign-in expired or was revoked. Sign in again.");
        void this.describe(r, res);
        this.needsSignIn(r, "Sign in to connect.");
      }
      if (res.status === 403) {
        const p = extractWWWAuthenticateParams(res);
        if (p.error === "insufficient_scope") {
          await res.body?.cancel().catch(() => {});
          const s = this.load(r.id);
          this.save(r.id, { ...s, scopeHint: union(s.tokens?.scope, s.scopeHint, p.scope) });
          this.needsSignIn(
            r,
            `The server needs more permissions (${p.scope ?? "more scopes"}). Sign in again.`,
          );
        }
      }
      return res;
    };
  }

  /** The tokens are dead (rejected, or expired with no way to refresh): forget them. */
  private signInGone(r: McpServerRecord, message: string): never {
    const s = this.load(r.id);
    if (s.tokens) this.save(r.id, { ...s, tokens: undefined, account: undefined });
    this.needsSignIn(r, message);
  }

  /**
   * Before any sign-in: read the resource metadata (a GET, nothing registered) for the name the
   * server gives itself, so Settings can say what the sign-in is for.
   */
  private async describe(r: McpServerRecord, res: Response): Promise<void> {
    if (this.load(r.id).resourceName !== undefined) return;
    try {
      const { resourceMetadataUrl } = extractWWWAuthenticateParams(res);
      if (resourceMetadataUrl) requireSecure(resourceMetadataUrl, "resource metadata URL");
      const prm = await discoverOAuthProtectedResourceMetadata(r.url!, { resourceMetadataUrl }, oauthFetch);
      const name = typeof prm.resource_name === "string" ? prm.resource_name.slice(0, 100) : null;
      this.save(r.id, { ...this.load(r.id), resourceName: name });
    } catch {}
  }

  private needsSignIn(r: McpServerRecord, message: string): never {
    this.events.needsAuth(r.id, message);
    throw new NeedsSignInError(r.name);
  }

  /** One refresh per server at a time; a caller holding outdated tokens gets the new ones. */
  private refresh(r: McpServerRecord, used: StoredTokens): Promise<StoredTokens> {
    const current = this.load(r.id).tokens;
    if (current && current.access_token !== used.access_token) return Promise.resolve(current);
    let p = this.refreshing.get(r.id);
    if (!p) {
      p = this.doRefresh(r, used).finally(() => this.refreshing.delete(r.id));
      this.refreshing.set(r.id, p);
    }
    return p;
  }

  private async doRefresh(r: McpServerRecord, used: StoredTokens): Promise<StoredTokens> {
    const state = this.load(r.id);
    if (!state.metadata || !used.refresh_token) this.needsSignIn(r, "Sign in to connect.");
    // A refresh token only ever goes back to the authorization server that issued it.
    if (state.metadata.issuer !== used.issuer) {
      this.needsSignIn(r, "The server's authorization server changed. Sign in again.");
    }
    try {
      const tokens = await refreshAuthorization(state.metadata.issuer, {
        metadata: state.metadata,
        clientInformation: used.client,
        refreshToken: used.refresh_token,
        resource: state.resource,
        fetchFn: oauthFetch,
      });
      const next = this.stored(tokens, used.issuer, used.client, used.scope, used);
      const latest = this.load(r.id);
      this.save(r.id, { ...latest, tokens: next, account: accountOf(tokens) ?? latest.account });
      return next;
    } catch (e) {
      if (
        e instanceof InvalidGrantError ||
        e instanceof InvalidClientError ||
        e instanceof UnauthorizedClientError
      ) {
        // The grant (or the client) is gone: forget the tokens, and a dead dynamic client too.
        const latest = this.load(r.id);
        const deadClient = !(e instanceof InvalidGrantError);
        this.save(r.id, {
          ...latest,
          tokens: undefined,
          account: undefined,
          ...(deadClient ? { client: undefined } : {}),
        });
        this.needsSignIn(r, "The sign-in expired or was revoked. Sign in again.");
      }
      throw new Error(`couldn't refresh the OAuth token: ${errorText(e)}`);
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
