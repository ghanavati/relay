#!/usr/bin/env bash
set -euo pipefail

repo="ghanavati/relay"
prefix="${RELAY_INSTALL_PREFIX:-$HOME/.local/share/relay}"
bin_dir="${RELAY_BIN_DIR:-$HOME/.local/bin}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target="darwin-arm64" ;;
  Darwin-x86_64) target="darwin-x64" ;;
  Linux-x86_64) target="linux-x64" ;;
  Linux-aarch64|Linux-arm64) target="linux-arm64" ;;
  *) echo "Relay does not yet ship for $(uname -s) $(uname -m)." >&2; exit 1 ;;
esac

command -v curl >/dev/null || { echo "curl is required." >&2; exit 1; }
command -v tar >/dev/null || { echo "tar is required." >&2; exit 1; }

api="https://api.github.com/repos/$repo/releases?per_page=20"
archive_url="$(curl -fsSL "$api" | grep -o 'https://[^" ]*relay-[^" ]*-'"$target"'\.tar\.gz' | head -n1)"
[[ -n "$archive_url" ]] || { echo "No Relay release archive is available for $target." >&2; exit 1; }
archive="${archive_url##*/}"
tag="${archive#relay-}"
tag="${tag%-${target}.tar.gz}"
checksum_url="https://github.com/$repo/releases/download/v$tag/SHA256SUMS.txt"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL "$archive_url" -o "$work/$archive"
curl -fsSL "$checksum_url" -o "$work/SHA256SUMS.txt"
(cd "$work" && { command -v shasum >/dev/null && shasum -a 256 -c SHA256SUMS.txt --ignore-missing || sha256sum -c SHA256SUMS.txt --ignore-missing; })

mkdir -p "$prefix" "$bin_dir"
tar -xzf "$work/$archive" -C "$prefix"
ln -sfn "$prefix/${archive%.tar.gz}/relay" "$bin_dir/relay"
echo "Relay $tag installed."
echo "Run: $bin_dir/relay setup --everything"
case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "Add $bin_dir to PATH to run relay directly." ;; esac
