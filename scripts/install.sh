#!/usr/bin/env bash
# scripts/install.sh
#
# One-line installer for Relay.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ghanavati/relay/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/ghanavati/relay/main/scripts/install.sh | bash -s -- --yes
#   ./scripts/install.sh [--yes] [--prefix <dir>] [--dry-run] [--reinstall]
#
# Behavior: clones (or updates) the Relay repo, installs deps, builds,
# npm-links the `relay` binary, runs `relay setup --everything --yes`, then
# `relay verify --json` to confirm install integrity.
# Idempotent: re-running detects existing install and updates in place.

set -euo pipefail

# -----------------------------------------------------------------------------
# Defaults / args
# -----------------------------------------------------------------------------

REPO_URL="https://github.com/ghanavati/relay.git"
DEFAULT_PREFIX="${HOME}/.local/share/relay"
PREFIX="${RELAY_INSTALL_PREFIX:-${DEFAULT_PREFIX}}"
ASSUME_YES=0
DRY_RUN=0
FORCE_REINSTALL=0
MIN_NODE_MAJOR=20

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift ;;
    --dry-run|-n) DRY_RUN=1; ASSUME_YES=1; shift ;;
    --reinstall) FORCE_REINSTALL=1; shift ;;
    --prefix)
      [[ $# -ge 2 ]] || { echo "ERROR: --prefix requires a directory" >&2; exit 1; }
      PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#*=}"; shift ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

log() { echo "$@"; }
run() { if [[ "${DRY_RUN}" -eq 1 ]]; then echo "  [dry-run] $*"; else "$@"; fi; }
die() { echo "ERROR: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

STAGE="init"
on_error() {
  local exit_code=$?
  echo "" >&2
  echo "ERROR: install failed during stage '${STAGE}' at line ${1:-?} (exit ${exit_code})." >&2
  case "${STAGE}" in
    preflight)  echo "  Hint: install Node.js ${MIN_NODE_MAJOR}+, git, and npm. See README.md." >&2 ;;
    npm-prefix) echo "  Hint: 'npm prefix -g' isn't writable. Re-run with: npm config set prefix \"\$HOME/.npm-global\" && export PATH=\"\$HOME/.npm-global/bin:\$PATH\"" >&2 ;;
    clone)      echo "  Hint: check network + that ${PREFIX} isn't a non-git directory." >&2 ;;
    install)    echo "  Hint: 'npm install' failed. Re-run: cd ${PREFIX} && npm install" >&2 ;;
    build)      echo "  Hint: 'npm run build' failed. Re-run: cd ${PREFIX} && npm run build" >&2 ;;
    link)       echo "  Hint: 'npm link' failed (likely permissions). See npm-prefix hint above." >&2 ;;
    setup)      echo "  Hint: 'relay setup' failed. Re-run manually: relay setup --everything --yes" >&2 ;;
    verify)     echo "  Hint: 'relay verify' reported failures. Re-run: relay verify (no --json) for details." >&2 ;;
    *)          echo "  Inspect ${PREFIX} for partial state, then re-run with 'bash -x scripts/install.sh'." >&2 ;;
  esac
  exit "${exit_code}"
}
trap 'on_error $LINENO' ERR

# -----------------------------------------------------------------------------
# Plan + confirmation
# -----------------------------------------------------------------------------

REINSTALL_TAG=""
if [[ "${FORCE_REINSTALL}" -eq 1 ]]; then REINSTALL_TAG="(reinstall) "; fi
cat <<EOF
Relay installer
===============
Plan:
  1. Verify Node.js ${MIN_NODE_MAJOR}+, git, npm, and a writable npm prefix.
  2. ${REINSTALL_TAG}Clone (or update) ${REPO_URL} into ${PREFIX}.
  3. npm install  ->  npm run build  ->  npm link.
  4. Run 'relay setup --everything --yes' (skipped if not yet shipped).
  5. Run 'relay verify --json' to confirm install integrity.
EOF
if [[ "${DRY_RUN}" -eq 1 ]]; then log ""; log "  (dry-run mode: no changes will be made)"; fi

if [[ "${ASSUME_YES}" -ne 1 ]]; then
  if [[ ! -t 0 ]]; then die "stdin not a TTY; pass --yes to install non-interactively."; fi
  printf "\nProceed? [y/N] "
  read -r reply
  case "${reply}" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 0 ;; esac
fi

# -----------------------------------------------------------------------------
# Stage 1: pre-flight (node version, npm prefix writability)
# -----------------------------------------------------------------------------
STAGE="preflight"
have git  || die "git is required but not found."
have node || die "Node.js ${MIN_NODE_MAJOR}+ is required but not found."
have npm  || die "npm is required but not found."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "${NODE_MAJOR}" -lt "${MIN_NODE_MAJOR}" ]]; then
  die "Node.js ${MIN_NODE_MAJOR}+ required (found $(node -v)). Upgrade via nvm/asdf/brew, then re-run."
fi
log ""
log "[preflight] node $(node -v), npm $(npm -v)"

STAGE="npm-prefix"
NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
if [[ -z "${NPM_PREFIX}" ]]; then die "could not resolve 'npm prefix -g'."; fi
if [[ ! -w "${NPM_PREFIX}" && ! -w "${NPM_PREFIX}/lib" && ! -w "$(dirname "${NPM_PREFIX}")" ]]; then
  echo "WARNING: npm global prefix '${NPM_PREFIX}' is not writable." >&2
  echo "  Without write access, 'npm link' will fail (or require sudo)." >&2
  echo "  Recommended fix (no sudo):" >&2
  echo "    mkdir -p \"\$HOME/.npm-global\" && npm config set prefix \"\$HOME/.npm-global\"" >&2
  echo "    export PATH=\"\$HOME/.npm-global/bin:\$PATH\"  # add to ~/.zshrc or ~/.bashrc" >&2
  echo "  Then re-run this installer." >&2
  if [[ "${ASSUME_YES}" -ne 1 ]]; then die "aborting; fix npm prefix and re-run, or use sudo at your own risk."; fi
fi

# Idempotency: detect existing relay binary
EXISTING_VERSION=""
if have relay; then EXISTING_VERSION="$(relay --version 2>/dev/null | head -n1 || true)"; fi
if [[ -n "${EXISTING_VERSION}" && "${FORCE_REINSTALL}" -ne 1 ]]; then
  log "[preflight] existing install detected: ${EXISTING_VERSION} — will upgrade in place."
fi

# -----------------------------------------------------------------------------
# Stage 2: clone or update
# -----------------------------------------------------------------------------
STAGE="clone"
run mkdir -p "$(dirname "${PREFIX}")"

if [[ -d "${PREFIX}/.git" ]]; then
  log ""
  log "[1/5] Updating existing checkout in ${PREFIX}..."
  run git -C "${PREFIX}" fetch --quiet origin
  run git -C "${PREFIX}" reset --quiet --hard origin/HEAD
else
  if [[ -e "${PREFIX}" ]]; then
    die "${PREFIX} exists but is not a git checkout. Refusing to overwrite. Pass --prefix elsewhere or remove it."
  fi
  log ""
  log "[1/5] Cloning ${REPO_URL} into ${PREFIX}..."
  run git clone --quiet --depth 1 "${REPO_URL}" "${PREFIX}"
fi

if [[ "${DRY_RUN}" -ne 1 ]]; then cd "${PREFIX}"; fi

# -----------------------------------------------------------------------------
# Stage 3-5: install + build + link
# -----------------------------------------------------------------------------
STAGE="install"; log "[2/5] Installing dependencies...";   run npm install --silent
STAGE="build";   log "[3/5] Building...";                  run npm run build --silent
STAGE="link";    log "[4/5] Linking 'relay' onto PATH..."; run npm link --silent

# -----------------------------------------------------------------------------
# Stage 6: post-install setup (graceful if missing)
# -----------------------------------------------------------------------------
STAGE="setup"
log ""
if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "  [dry-run] relay setup --everything --yes"
elif relay setup --everything --yes 2>/dev/null; then
  :
else
  log "Note: 'relay setup --everything --yes' is not available in this build — skipping."
fi

# -----------------------------------------------------------------------------
# Stage 7: verify install integrity (T16 smoke command)
# -----------------------------------------------------------------------------
STAGE="verify"
log ""
log "[5/5] Verifying install integrity..."
if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "  [dry-run] relay verify --json"
elif have relay; then
  VERIFY_JSON="$(relay verify --json 2>/dev/null || true)"
  if [[ -z "${VERIFY_JSON}" ]]; then
    echo "WARNING: 'relay verify --json' produced no output (older build?). Run 'relay verify' manually." >&2
  else
    # Parse with node to avoid jq dependency.
    VERIFY_OK="$(node -e "try{const r=JSON.parse(process.argv[1]);console.log(r.ok?'true':'false');}catch(e){console.log('parse-error');}" "${VERIFY_JSON}" 2>/dev/null || echo parse-error)"
    if [[ "${VERIFY_OK}" == "true" ]]; then
      log "  relay verify: all critical checks passed."
    else
      echo "" >&2
      echo "WARNING: 'relay verify' reported issues (ok=${VERIFY_OK})." >&2
      echo "  Recovery: run 'relay verify' (no --json) to see per-check status, then 'relay doctor' for provider/db health." >&2
      echo "  Raw JSON: ${VERIFY_JSON}" >&2
    fi
  fi
else
  echo "WARNING: 'relay' not on PATH after install. Check that '$(npm prefix -g)/bin' is in PATH." >&2
fi

log ""
log "Done. Run 'relay info' (or 'relay --help') to explore."
