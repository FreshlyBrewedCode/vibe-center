/**
 * True unless the request carries an Origin from another host. Browsers send Origin on
 * cross-site requests and WebSocket handshakes; behind `tailscale serve` (or the Vite dev proxy)
 * the public host arrives as Host or X-Forwarded-Host.
 */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [req.headers.get("host"), req.headers.get("x-forwarded-host")]
    .filter((h): h is string => !!h)
    .flatMap((h) => h.split(",").map((x) => x.trim()));
  return hosts.includes(originHost);
}
