#!/usr/bin/env bash
# scripts/install.sh
#
# One-line installer for Relay.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ghanavati/relay/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/ghanavati/relay/main/scripts/install.sh | bash -s -- --yes
#   ./scripts/install.sh [--yes] [--prefix <dir>]
#
# Behavior: clones (or updates) the Relay repo, installs deps, builds,
# npm links the `relay` binary, and runs `relay setup --everything --yes`.
# Idempotent: re-running updates an existing checkout in place.

set -euo pipefail

# -----------------------------------------------------------------------------
# Defaults / args
# -----------------------------------------------------------------------------

REPO_URL="https://github.com/ghanavati/relay.git"
DEFAULT_PREFIX="${HOME}/.local/share/relay"
PREFIX="${RELAY_INSTALL_PREFIX:-${DEFAULT_PREFIX}}"
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    --prefix)
      [[ $# -ge 2 ]] || { echo "ERROR: --prefix requires a directory" >&2; exit 1; }
      PREFIX="$2"
      shift 2
      ;;
    --prefix=*)
      PREFIX="${1#*=}"
      shift
      ;;
    -h|--help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# -----------------------------------------------------------------------------
# Error trap
# -----------------------------------------------------------------------------

on_error() {
  local exit_code=$?
  local line_no=${1:-unknown}
  echo "" >&2
  echo "ERROR: install failed at line ${line_no} (exit ${exit_code})." >&2
  echo "  - Verify Node 20+, git, and a network connection." >&2
  echo "  - Inspect ${PREFIX} for partial state." >&2
  echo "  - Re-run with 'bash -x scripts/install.sh' for verbose output." >&2
  exit "${exit_code}"
}
trap 'on_error $LINENO' ERR

# -----------------------------------------------------------------------------
# Plan + confirmation
# -----------------------------------------------------------------------------

cat <<EOF
Relay one-line installer
========================
This script will:
  1. Verify Node.js 20+ is installed.
  2. Clone (or update) ${REPO_URL} into ${PREFIX}.
  3. Run 'npm install' and 'npm run build' inside ${PREFIX}.
  4. Run 'npm link' so 'relay' is available on your PATH.
  5. Run 'relay setup --everything --yes' (skipped if not yet shipped).
EOF

if [[ "${ASSUME_YES}" -ne 1 ]]; then
  if [[ ! -t 0 ]]; then
    echo "" >&2
    echo "ERROR: stdin not a TTY; pass --yes to install non-interactively." >&2
    exit 1
  fi
  printf "\nProceed? [y/N] "
  read -r reply
  case "${reply}" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

# -----------------------------------------------------------------------------
# Pre-flight checks
# -----------------------------------------------------------------------------

command -v git >/dev/null 2>&1 || { echo "ERROR: git is required but not found." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js 20+ is required but not found." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "ERROR: npm is required but not found." >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  echo "ERROR: Node.js 20+ required (found $(node -v))." >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Clone or update
# -----------------------------------------------------------------------------

mkdir -p "$(dirname "${PREFIX}")"

if [[ -d "${PREFIX}/.git" ]]; then
  echo ""
  echo "[1/4] Updating existing checkout in ${PREFIX}..."
  git -C "${PREFIX}" fetch --quiet origin
  git -C "${PREFIX}" reset --quiet --hard origin/HEAD
else
  if [[ -e "${PREFIX}" ]]; then
    echo "ERROR: ${PREFIX} exists but is not a git checkout. Refusing to overwrite." >&2
    exit 1
  fi
  echo ""
  echo "[1/4] Cloning ${REPO_URL} into ${PREFIX}..."
  git clone --quiet --depth 1 "${REPO_URL}" "${PREFIX}"
fi

cd "${PREFIX}"

# -----------------------------------------------------------------------------
# Install + build + link
# -----------------------------------------------------------------------------

echo "[2/4] Installing dependencies..."
npm install --silent

echo "[3/4] Building..."
npm run build --silent

echo "[4/4] Linking 'relay' onto PATH..."
npm link --silent

# -----------------------------------------------------------------------------
# Post-install setup (T37 — graceful if missing)
# -----------------------------------------------------------------------------

echo ""
if relay setup --everything --yes 2>/dev/null; then
  :
else
  echo "Note: 'relay setup --everything --yes' is not yet available in this build — skipping."
fi

echo ""
echo "Done. Run 'relay info' to verify."
