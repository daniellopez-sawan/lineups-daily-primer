#!/bin/sh
# Self-update for the Lineups Daily Primer skill. Needs only curl + tar + gzip (built into macOS).
# Always exits 0 — an update failure must never block a run.
# Prints exactly one of: "updated to <sha>", "already up to date", "update check skipped: <why>".
DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="daniellopez-sawan/lineups-daily-primer"
VERSION_FILE="$DIR/.version"

for t in curl tar gzip; do
  command -v "$t" >/dev/null 2>&1 || { echo "update check skipped: $t not found"; exit 0; }
done

LOCAL=$(cat "$VERSION_FILE" 2>/dev/null | tr -d ' \n')
TMP=$(mktemp -d 2>/dev/null) || { echo "update check skipped: no temp dir"; exit 0; }
trap 'rm -rf "$TMP"' EXIT

# 1. Newest commit on main (GitHub API). Fallback when rate-limited/offline: the branch tarball,
#    which may lag a few minutes behind but is never wrong about what it contains.
REMOTE=$(curl -fsSL --max-time 8 "https://api.github.com/repos/$REPO/commits/main" 2>/dev/null \
  | sed -n 's/^ *"sha": *"\([0-9a-f]\{40\}\)".*/\1/p' | head -1)
if [ -n "$REMOTE" ]; then
  [ "$LOCAL" = "$REMOTE" ] && { echo "already up to date"; exit 0; }
  URL="https://codeload.github.com/$REPO/tar.gz/$REMOTE"      # exact commit — never a stale cache
else
  URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/main"
fi

# 2. Download and read the commit stamp GitHub embeds in every archive.
curl -fsSL --max-time 30 "$URL" -o "$TMP/skill.tgz" 2>/dev/null \
  || { echo "update check skipped: could not reach GitHub"; exit 0; }
GOT=$(gzip -dc "$TMP/skill.tgz" 2>/dev/null | head -c 4096 | tr -c '[:print:]' '\n' | sed -n 's/.*comment=\([0-9a-f]\{40\}\).*/\1/p' | head -1)
[ -z "$GOT" ] && { echo "update check skipped: bad download"; exit 0; }
[ "$LOCAL" = "$GOT" ] && { echo "already up to date"; exit 0; }

# 3. Unpack, sanity-check, copy over the install. Never touches fixtures/live-*.json or the plan cache.
mkdir "$TMP/x" && tar -xzf "$TMP/skill.tgz" --strip-components=1 -C "$TMP/x" 2>/dev/null
[ -f "$TMP/x/SKILL.md" ] && [ -f "$TMP/x/scripts/map.mjs" ] || { echo "update check skipped: bad download"; exit 0; }
cp -R "$TMP/x/." "$DIR/" 2>/dev/null || { echo "update check skipped: could not write to $DIR"; exit 0; }
printf '%s\n' "$GOT" > "$VERSION_FILE"          # record what was actually installed
echo "updated to $(printf '%s' "$GOT" | cut -c1-7)"
