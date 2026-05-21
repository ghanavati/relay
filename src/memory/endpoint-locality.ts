/**
 * Endpoint locality gate — shared between auto-extract (transcript send) and
 * the embedding flow (memory content + recall query embed). Both paths ship
 * raw memory content / user query text to LM Studio's HTTP API; pointing the
 * endpoint at a non-loopback host silently exfiltrates that data off-host.
 *
 * Localhost = `127.0.0.1`, `::1`, or `localhost`. Any unparseable URL is
 * treated as non-local (fail-closed). IPv6 brackets are stripped before
 * comparison so `http://[::1]:1234` matches.
 *
 * Mirrors the original implementation in cmd-memory-auto-extract.ts which
 * remains the canonical source for the auto-extract pipeline; this file
 * exists so the memory write/recall path can share the same gate without
 * importing from a CLI command module (layering would be wrong-way).
 */

const LOCALHOST_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLocalEndpoint(endpoint: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  // URL.hostname keeps IPv6 brackets stripped by spec, but be defensive.
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return LOCALHOST_HOSTS.has(host);
}
