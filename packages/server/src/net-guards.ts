// The cheap network defenses that make a localhost-bound control plane safe
// against a browser tab on a hostile page — DNS-rebinding and CSRF — WITHOUT
// changing the local UX. A loopback server with no token is still the default;
// these guards just stop a remote web page from reaching through the user's
// browser to drive agents on their machine.
//
// Pure string predicates (no `node:http` import) so they unit-test in isolation;
// `http.ts` feeds them the request headers and `control-plane.ts` feeds the bind
// host. The threat model and why each guard is sufficient live next to it.

// A loopback hostname: `localhost` (+ RFC-6761 `*.localhost`), the whole
// 127.0.0.0/8 block, and IPv6 `::1`. IPv6 brackets (`[::1]`) are stripped first.
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// Whether the BIND host keeps the plane on this machine. `0.0.0.0` / `::` (all
// interfaces) and any LAN/public address are NOT loopback — binding there
// exposes the plane, so the caller must require a token (see control-plane.ts).
export function isLoopbackBindHost(host: string): boolean {
  return isLoopbackHostname(host);
}

// Parse the hostname out of a `host[:port]` (or bracketed IPv6) value via the
// URL parser, which normalizes brackets and ports. Returns null for an
// absent/garbage value so the caller can refuse rather than trust it.
function hostnameOf(hostHeader: string | undefined): string | null {
  if (hostHeader === undefined || hostHeader.length === 0) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// DNS-rebinding defense. When the surface is NOT token-gated (the open loopback
// default), the request's `Host` header must name a loopback address. A hostile
// page that rebinds its own domain to 127.0.0.1 still sends `Host: evil.example`
// — this refuses it. When a token gates the surface, the token is the authority
// and a LAN / tunnel `Host` is expected, so the check is skipped (the rebind
// attacker cannot supply the token, so auth refuses it anyway).
export function hostHeaderAllowed(hostHeader: string | undefined, tokenGated: boolean): boolean {
  if (tokenGated) return true;
  const host = hostnameOf(hostHeader);
  return host !== null && isLoopbackHostname(host);
}

// CSRF defense for state-changing methods. A browser always sends `Origin` on a
// cross-site write; if present it must be same-origin (its host:port equals the
// request's `Host`). Absent → a non-browser client (curl, the CLI, a poller)
// with no forgeable ambient credentials → allowed. A malformed / opaque
// (`"null"`) Origin on a write is refused.
export function originAllowed(originHeader: string | undefined, hostHeader: string | undefined): boolean {
  if (originHeader === undefined) return true;
  let originHost: string;
  try {
    originHost = new URL(originHeader).host.toLowerCase();
  } catch {
    return false;
  }
  const host = (hostHeader ?? "").toLowerCase();
  return host.length > 0 && originHost === host;
}

// State-changing methods get the Origin check; GETs (read-model, SSE) are
// cross-origin-read-blocked by the browser and carry no write.
export function isStateChanging(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH";
}
