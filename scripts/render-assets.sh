#!/usr/bin/env bash
# Re-render mascot PNGs and the social preview from their SVG sources.
# Requires librsvg (provides rsvg-convert): brew install librsvg
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MASCOT="$REPO_ROOT/assets/mascot"
SOCIAL="$REPO_ROOT/assets/social"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "rsvg-convert not found. Install librsvg first:" >&2
  echo "  brew install librsvg   # macOS" >&2
  echo "  apt install librsvg2-bin   # Debian / Ubuntu" >&2
  exit 1
fi

cd "$REPO_ROOT"

rsvg-convert -w 768 "$MASCOT/foreman-beaver.svg"      -o "$MASCOT/foreman-beaver-768.png"
rsvg-convert -w 256 "$MASCOT/foreman-beaver.svg"      -o "$MASCOT/foreman-beaver-256.png"
rsvg-convert -w 64  "$MASCOT/foreman-beaver.svg"      -o "$MASCOT/foreman-beaver-64.png"
rsvg-convert -w 32  "$MASCOT/foreman-beaver-icon.svg" -o "$MASCOT/foreman-beaver-icon-32.png"
rsvg-convert -w 1280 "$SOCIAL/og-card.svg"            -o "$SOCIAL/og-card.png"

echo "Rendered:"
ls -la "$MASCOT"/*.png "$SOCIAL"/*.png
