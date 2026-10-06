#!/usr/bin/env bash
# ckanban installer (macOS).
#   curl -fsSL https://raw.githubusercontent.com/leoawesome/kanban/main/install.sh | bash
# Env: CKANBAN_VERSION=0.1.0 (default: latest)  CKANBAN_BIN_DIR=~/.local/bin  CKANBAN_NO_DAEMON=1 (skip launchd)
set -euo pipefail

REPO="leoawesome/kanban"
BIN_DIR="${CKANBAN_BIN_DIR:-$HOME/.local/bin}"
VERSION="${CKANBAN_VERSION:-latest}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "ckanban currently supports macOS only."
case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) die "Unsupported CPU: $(uname -m)" ;;
esac

ASSET="ckanban-darwin-${ARCH}"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
  URL="https://github.com/${REPO}/releases/download/v${VERSION#v}/${ASSET}"
fi

URL="${CKANBAN_DOWNLOAD_URL:-$URL}"
bold "Installing ckanban (${VERSION}, darwin-${ARCH})"
mkdir -p "$BIN_DIR"
TMP="$(mktemp -t ckanban)"
trap 'rm -f "$TMP"' EXIT
curl -fL --progress-bar -o "$TMP" "$URL" || die "Download failed: $URL"
chmod 755 "$TMP"
xattr -d com.apple.quarantine "$TMP" 2>/dev/null || true
mv "$TMP" "$BIN_DIR/ckanban"
trap - EXIT
echo "✓ Installed $BIN_DIR/ckanban ($("$BIN_DIR/ckanban" --version))"

missing=0
command -v claude >/dev/null 2>&1 || { warn "claude CLI not found. Install Claude Code: https://claude.com/claude-code"; missing=1; }
command -v git >/dev/null 2>&1 || { warn "git not found (xcode-select --install)"; missing=1; }
command -v gh >/dev/null 2>&1 || warn "gh CLI not found: PR features disabled (brew install gh && gh auth login)"

if [ -z "${CKANBAN_NO_DAEMON:-}" ]; then
  "$BIN_DIR/ckanban" install
  sleep 1
  open "http://localhost:7777" 2>/dev/null || true
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH. Add this to ~/.zshrc:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo
bold "Done. Board: http://localhost:7777"
echo "Update later with: ckanban update"
[ "$missing" = 0 ] || warn "Install the missing tools above, then run: ckanban restart"
