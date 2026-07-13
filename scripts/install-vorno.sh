#!/usr/bin/env bash
#
# install-vorno.sh — FIRST-install helper for Vorno (macOS, arm64).
#
# Installs Vorno.app into /Applications from a local .dmg/.zip or the newest
# release on the public Swagatar-LLC/vorno-releases feed. This is for the FIRST
# install only (or a manual reinstall): once Vorno is running, Squirrel.Mac /
# electron-updater owns all subsequent updates — do NOT script this into an
# update loop.
#
# Usage:
#   scripts/install-vorno.sh <path-to-Vorno-arm64.dmg | path-to-Vorno-arm64.zip>
#   scripts/install-vorno.sh --latest      # fetch newest from vorno-releases
#
set -euo pipefail

REPO="Swagatar-LLC/vorno-releases"
APP_NAME="Vorno.app"
DEST="/Applications"
ASSET="Vorno-arm64.dmg"

usage() { sed -n '3,17p' "$0"; exit "${1:-0}"; }

[ $# -eq 1 ] || usage 1
case "$1" in -h|--help) usage 0 ;; esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; [ -n "${MOUNT:-}" ] && hdiutil detach "$MOUNT" -quiet 2>/dev/null || true' EXIT

if [ "$1" = "--latest" ]; then
  echo "Fetching latest ${ASSET} from ${REPO}…"
  if command -v gh >/dev/null 2>&1; then
    gh release download --repo "$REPO" --pattern "$ASSET" --dir "$TMP"
  else
    URL="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
      | python3 -c "import sys,json;print(next(a['browser_download_url'] for a in json.load(sys.stdin)['assets'] if a['name']=='${ASSET}'))")"
    curl -fSL "$URL" -o "$TMP/$ASSET"
  fi
  SRC="$TMP/$ASSET"
else
  SRC="$1"
  [ -f "$SRC" ] || { echo "Error: file not found: $SRC" >&2; exit 1; }
fi

# Resolve Vorno.app out of the DMG or ZIP into $TMP/extracted/
EXTRACT="$TMP/extracted"
mkdir -p "$EXTRACT"
case "$SRC" in
  *.dmg)
    echo "Mounting $SRC…"
    MOUNT="$(hdiutil attach "$SRC" -nobrowse -readonly -mountrandom /tmp | grep -o '/tmp/[^ ]*' | tail -1)"
    cp -R "$MOUNT/$APP_NAME" "$EXTRACT/"
    hdiutil detach "$MOUNT" -quiet
    MOUNT=""
    ;;
  *.zip)
    echo "Unzipping $SRC…"
    ditto -x -k "$SRC" "$EXTRACT"
    ;;
  *)
    echo "Error: expected a .dmg or .zip, got: $SRC" >&2
    exit 1
    ;;
esac

[ -d "$EXTRACT/$APP_NAME" ] || { echo "Error: $APP_NAME not found inside $SRC" >&2; exit 1; }

echo "Installing to ${DEST}/${APP_NAME} (replacing any existing copy)…"
rm -rf "${DEST:?}/${APP_NAME}"
cp -R "$EXTRACT/$APP_NAME" "$DEST/"
# Clear the quarantine flag so the first launch isn't blocked (matters most for
# ad-hoc/unsigned verification builds).
xattr -dr com.apple.quarantine "${DEST}/${APP_NAME}" 2>/dev/null || true

echo "Done. Launch with: open \"${DEST}/${APP_NAME}\""
echo "Updates from here on are automatic (Squirrel.Mac)."
