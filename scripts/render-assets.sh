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

rsvg-convert -w 768 "$MASCOT/foreman-beaver.svg"        -o "$MASCOT/foreman-beaver-768.png"
rsvg-convert -w 256 "$MASCOT/foreman-beaver.svg"        -o "$MASCOT/foreman-beaver-256.png"
rsvg-convert -w 64  "$MASCOT/foreman-beaver.svg"        -o "$MASCOT/foreman-beaver-64.png"
rsvg-convert -w 32  "$MASCOT/foreman-beaver-icon.svg"   -o "$MASCOT/foreman-beaver-icon-32.png"
rsvg-convert -w 1280 "$SOCIAL/og-card.svg"              -o "$SOCIAL/og-card.png"

# Terminal-renderable sizes for the boot mascot. Cell aspect ≈ 1:2, so the PNG
# pixel ratio is widened so chafa produces near-square output cells.
rsvg-convert -w 640 -h 360 "$MASCOT/foreman-beaver.svg"        -o "$MASCOT/terminal-large.png"
rsvg-convert -w 640 -h 360 "$MASCOT/foreman-beaver-blink.svg"  -o "$MASCOT/terminal-large-blink.png"
rsvg-convert -w 320 -h 180 "$MASCOT/foreman-beaver.svg"        -o "$MASCOT/terminal-medium.png"
rsvg-convert -w 320 -h 180 "$MASCOT/foreman-beaver-blink.svg"  -o "$MASCOT/terminal-medium-blink.png"
rsvg-convert -w 128 -h 72  "$MASCOT/foreman-beaver.svg"        -o "$MASCOT/terminal-small.png"

echo "Rendered:"
ls -la "$MASCOT"/*.png "$SOCIAL"/*.png
