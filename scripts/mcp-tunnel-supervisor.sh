#!/usr/bin/env bash
# scripts/mcp-tunnel-supervisor.sh
#
# Run this yourself in a terminal you leave open whenever you want ChatGPT's
# connector to reach Relay's memory: `./scripts/mcp-tunnel-supervisor.sh`.
# Ctrl+C stops everything. Not a background service — nothing here touches
# launchd or auto-starts at login.
#
# Starts a Cloudflare quick tunnel + `relay mcp --http --oauth` as a bound
# pair: quick tunnels need no Cloudflare account but mint a NEW random
# hostname every time they (re)connect, and today's outage happened because
# the two processes' lifecycles weren't linked — cloudflared died silently
# while relay kept serving under the old (now-dead) RELAY_MCP_PUBLIC_URL.
# Here, if either process dies, both are torn down and restarted together
# with a freshly-captured URL, for as long as this script keeps running.
#
# The current URL is always at $URL_FILE — paste it into ChatGPT's connector
# settings whenever it changes (i.e. whenever the pair restarts).
#
# If Ctrl+C ever leaves something behind (it shouldn't — the EXIT trap below
# covers signal-induced termination, not just normal exit), the fallback is:
#   pkill -f 'cloudflared tunnel --url'; pkill -f 'dist/cli.js mcp'

set -uo pipefail

PORT=8765
RELAY_DIR="/Users/ghanavati/ai-stack/Projects/Relay"
NODE_BIN="/Users/ghanavati/.local/bin/node"
CLOUDFLARED_BIN="/opt/homebrew/bin/cloudflared"
SECRET_FILE="$HOME/.relay/mcp-owner-secret"
URL_FILE="$HOME/.relay/mcp-tunnel-url.txt"
CF_LOG="$HOME/.relay/cloudflared.log"

mkdir -p "$HOME/.relay"

if [[ ! -s "$SECRET_FILE" ]]; then
  echo "missing or empty $SECRET_FILE (chmod 600, one line, >=16 chars) — refusing to start unauthenticated" >&2
  exit 1
fi
RELAY_MCP_OWNER_SECRET=$(<"$SECRET_FILE")

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
  "$CLOUDFLARED_BIN" tunnel --url "http://localhost:$PORT" >"$CF_LOG" 2>&1 &
  CF_PID=$!

  local url=""
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

  echo "$url" >"$URL_FILE"
  echo "$(date -u +%FT%TZ) tunnel up: $url  <- paste this into ChatGPT's connector settings" >&2

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
