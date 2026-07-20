#!/usr/bin/env bash
# scripts/mcp-tunnel-supervisor.sh
#
# Run this yourself in a terminal you leave open whenever you want ChatGPT's
# connector to reach Relay's memory: `./scripts/mcp-tunnel-supervisor.sh`.
# Ctrl+C stops everything. Not a background service — nothing here touches
# launchd or auto-starts at login.
#
# Starts the NAMED Cloudflare tunnel "relay" + `relay mcp --http --oauth` as a
# bound pair: if either process dies, both are torn down and restarted together
# (the Jul 1 outage was cloudflared dying silently while relay kept serving a
# dead public URL). The tunnel serves a STABLE hostname (RELAY_TUNNEL_HOSTNAME,
# e.g. relay.example.com on a Cloudflare-hosted zone you own), so ChatGPT's
# connector is configured ONCE and never re-pasted — restarts are invisible to
# it, and OAuth client registrations survive restarts too
# (~/.relay/mcp-oauth-state.json).
#
# One-time setup for the stable hostname (until it's done, the script falls
# back to a throwaway trycloudflare URL that must be re-pasted into ChatGPT
# after each restart):
#   cloudflared tunnel login                              # browser: authorize your zone
#   cloudflared tunnel create relay
#   cloudflared tunnel route dns relay <your-hostname>
#
# If Ctrl+C ever leaves something behind (it shouldn't — the EXIT trap below
# covers signal-induced termination, not just normal exit), the fallback is:
#   pkill -f 'cloudflared tunnel'; pkill -f 'dist/cli.js mcp'

set -uo pipefail

PORT=8765
RELAY_DIR="${RELAY_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-/opt/homebrew/bin/cloudflared}"
SECRET_FILE="$HOME/.relay/mcp-owner-secret"
URL_FILE="$HOME/.relay/mcp-tunnel-url.txt"
CF_LOG="$HOME/.relay/cloudflared.log"
TUNNEL_NAME="${RELAY_TUNNEL_NAME:-relay}"
TUNNEL_HOSTNAME="${RELAY_TUNNEL_HOSTNAME:-}"
PUBLIC_URL="https://$TUNNEL_HOSTNAME"

: "${NODE_BIN:?node not found in PATH — set NODE_BIN}"

mkdir -p "$HOME/.relay"

if [[ ! -s "$SECRET_FILE" ]]; then
  echo "missing or empty $SECRET_FILE (chmod 600, one line, >=16 chars) — refusing to start unauthenticated" >&2
  exit 1
fi
RELAY_MCP_OWNER_SECRET=$(<"$SECRET_FILE")

# Stable named tunnel when it exists; throwaway quick tunnel until then.
TUNNEL_MODE="quick"
if [[ -n "$TUNNEL_HOSTNAME" ]] && "$CLOUDFLARED_BIN" tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  TUNNEL_MODE="named"
else
  {
    echo "named tunnel \"$TUNNEL_NAME\" not set up (or RELAY_TUNNEL_HOSTNAME unset) — using a throwaway URL for now."
    echo "one-time setup for a permanent https://${TUNNEL_HOSTNAME:-<your-hostname>} address:"
    echo "  export RELAY_TUNNEL_HOSTNAME=<your-hostname>   # on a Cloudflare-hosted zone you own"
    echo "  $CLOUDFLARED_BIN tunnel login            # browser: authorize the zone"
    echo "  $CLOUDFLARED_BIN tunnel create $TUNNEL_NAME"
    echo "  $CLOUDFLARED_BIN tunnel route dns $TUNNEL_NAME \$RELAY_TUNNEL_HOSTNAME"
  } >&2
fi

# No custom INT/TERM trap: Ctrl+C's default effect (terminate this script) is
# what we want, and a plain EXIT trap fires on that just as reliably as on
# normal completion — it's the standard bash idiom for "always clean up
# children," and doesn't depend on a custom signal handler's timing.
CF_PID=""
RELAY_PID=""
cleanup() {
  [[ -n "$CF_PID" ]] && kill "$CF_PID" 2>/dev/null
  [[ -n "$RELAY_PID" ]] && kill "$RELAY_PID" 2>/dev/null
}
trap cleanup EXIT

run_pair() {
  local url=""
  if [[ "$TUNNEL_MODE" == "named" ]]; then
    "$CLOUDFLARED_BIN" tunnel run --url "http://localhost:$PORT" "$TUNNEL_NAME" >"$CF_LOG" 2>&1 &
    CF_PID=$!
    url="$PUBLIC_URL"
    echo "$(date -u +%FT%TZ) tunnel up: $url (stable hostname — ChatGPT is configured once, restarts change nothing)" >&2
  else
    "$CLOUDFLARED_BIN" tunnel --url "http://localhost:$PORT" >"$CF_LOG" 2>&1 &
    CF_PID=$!
    for _ in $(seq 1 40); do
      url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" 2>/dev/null | head -1)
      [[ -n "$url" ]] && break
      kill -0 "$CF_PID" 2>/dev/null || break
      sleep 0.5
    done
    if [[ -z "$url" ]]; then
      echo "cloudflared did not report a tunnel URL within 20s — see $CF_LOG" >&2
      kill "$CF_PID" 2>/dev/null
      CF_PID=""
      return 1
    fi
    echo "$(date -u +%FT%TZ) tunnel up: $url  <- paste this into ChatGPT's connector settings" >&2
  fi

  echo "$url" >"$URL_FILE"

  RELAY_MCP_OWNER_SECRET="$RELAY_MCP_OWNER_SECRET" \
  RELAY_MCP_PUBLIC_URL="$url" \
  RELAY_MCP_HTTP_LOG=1 \
    "$NODE_BIN" "$RELAY_DIR/dist/cli.js" mcp --http --oauth --port "$PORT" &
  RELAY_PID=$!

  # Block until EITHER child dies (bash 3.2 on macOS has no `wait -n` — poll).
  while kill -0 "$CF_PID" 2>/dev/null && kill -0 "$RELAY_PID" 2>/dev/null; do
    sleep 1
  done
  kill "$CF_PID" "$RELAY_PID" 2>/dev/null
  wait "$CF_PID" "$RELAY_PID" 2>/dev/null
  CF_PID=""
  RELAY_PID=""
}

echo "starting relay mcp tunnel — Ctrl+C to stop"
while true; do
  run_pair
  echo "$(date -u +%FT%TZ) pair exited, restarting in 2s..." >&2
  sleep 2
done
