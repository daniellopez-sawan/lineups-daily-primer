#!/bin/sh
# Self-update for the Lineups Daily Primer skill. Needs only curl + tar (built into macOS).
# Always exits 0 — an update failure must never block a run.
# Prints exactly one of: "updated to <sha>", "already up to date", "update check skipped: <why>".
DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="daniellopez-sawan/lineups-daily-primer"
VERSION_FILE="$DIR/.version"

command -v curl >/dev/null 2>&1 || { echo "update check skipped: curl not found"; exit 0; }
command -v tar  >/dev/null 2>&1 || { echo "update check skipped: tar not found";  exit 0; }

REMOTE=$(curl -fsSL --max-time 8 "https://api.github.com/repos/$REPO/commits/main" 2>/dev/null \
  | sed -n 's/^ *"sha": *"\([0-9a-f]\{40\}\)".*/\1/p' | head -1)
if [ -z "$REMOTE" ]; then
  # API rate-limited or offline: try the raw file the release carries.
  REMOTE=$(curl -fsSL --max-time 8 "https://raw.githubusercontent.com/$REPO/main/.release" 2>/dev/null | tr -d ' \n')
fi
[ -z "$REMOTE" ] && { echo "update check skipped: could not reach GitHub"; exit 0; }

LOCAL=$(cat "$VERSION_FILE" 2>/dev/null | tr -d ' \n')
[ "$LOCAL" = "$REMOTE" ] && { echo "already up to date"; exit 0; }

TMP=$(mktemp -d 2>/dev/null) || { echo "update check skipped: no temp dir"; exit 0; }
trap 'rm -rf "$TMP"' EXIT
if ! curl -fsSL --max-time 30 "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" -o "$TMP/skill.tgz" 2>/dev/null; then
  echo "update check skipped: download failed"; exit 0
fi
mkdir "$TMP/x" && tar -xzf "$TMP/skill.tgz" --strip-components=1 -C "$TMP/x" 2>/dev/null
[ -f "$TMP/x/SKILL.md" ] && [ -f "$TMP/x/scripts/map.mjs" ] || { echo "update check skipped: bad download"; exit 0; }

# Copy over the installed files (never touches fixtures/live-*.json or the plan cache).
cp -R "$TMP/x/." "$DIR/" 2>/dev/null || { echo "update check skipped: could not write to $DIR"; exit 0; }
printf '%s\n' "$REMOTE" > "$VERSION_FILE"
echo "updated to $(printf '%s' "$REMOTE" | cut -c1-7)"
