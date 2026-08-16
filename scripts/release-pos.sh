#!/usr/bin/env bash
#
# release-pos.sh — one-shot Jingles POS release.
#
# Bumps the patch version, builds shared/backend/web/electron, pushes the
# bump to GitHub, deploys the live web/backend on pos.theredsun.org (git
# pull, build, run pending Prisma migrations, restart PM2), then builds and
# publishes a new desktop auto-update package for the Electron app.
#
# Must be run from a Windows machine with the desktop build toolchain
# (electron-builder --win nsis needs Windows), with a clean `main` branch
# that is already in sync with origin/main.
#
# Signing: build-update.cjs (invoked in step 3) refuses to publish an
# unsigned installer unless one of these is set beforehand:
#   JINGLES_ALLOW_UNSIGNED_UPDATES=1                 - ship unsigned
#   JINGLES_WINDOWS_PUBLISHER + CSC_LINK (or WIN_CSC_LINK) - ship signed
#
# Remote target is configurable so this isn't hard-coded to one operator's
# SSH setup:
#   RELEASE_SSH_HOST   (default: EdgeNewServer)
#   RELEASE_APP_DIR    (default: /var/www/federation-inventory/jingles-pos)
#   RELEASE_UPDATE_DIR (default: /var/www/federation-inventory/desktop-updates/pos)
#   RELEASE_PM2_APP    (default: jingles-pos-backend)
#
# Usage:
#   JINGLES_ALLOW_UNSIGNED_UPDATES=1 ./scripts/release-pos.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SSH_HOST="${RELEASE_SSH_HOST:-EdgeNewServer}"
APP_DIR="${RELEASE_APP_DIR:-/var/www/federation-inventory/jingles-pos}"
UPDATE_DIR="${RELEASE_UPDATE_DIR:-/var/www/federation-inventory/desktop-updates/pos}"
PM2_APP="${RELEASE_PM2_APP:-jingles-pos-backend}"

log() { printf '\n=== %s ===\n' "$1"; }

# ── 0. Preconditions ─────────────────────────────────────────────────────
log "Checking working tree"
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean. Commit or stash changes before releasing." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "Refusing to release from branch '$BRANCH' (expected 'main')." >&2
  exit 1
fi

git fetch origin
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "Local main is not in sync with origin/main. Pull or push first." >&2
  exit 1
fi

# ── 1. Bump version (root + electron package.json must match) ───────────
log "Bumping version"
CURRENT_VERSION="$(node -p "require('./package.json').version")"
NEXT_VERSION="$(node -e "
  const [maj, min, patch] = require('./package.json').version.split('.').map(Number);
  console.log([maj, min, patch + 1].join('.'));
")"
echo "Current version: $CURRENT_VERSION"
echo "Next version:    $NEXT_VERSION"

npm pkg set version="$NEXT_VERSION" >/dev/null
npm pkg set version="$NEXT_VERSION" --workspace=packages/electron >/dev/null

git add package.json packages/electron/package.json
git commit -m "chore(release): bump version to v${NEXT_VERSION}"
git push origin main

# ── 2. Build shared, backend, web, and the Electron app ─────────────────
log "Building shared, backend, web, and Electron (native rebuild included)"
npm run build:desktop

# ── 3. Build and verify the desktop auto-update package ──────────────────
log "Building the desktop auto-update package"
npm run build:update --workspace=packages/electron

log "Verifying the release artifact"
npm run verify:release --workspace=packages/electron

INSTALLER_NAME="Jingles POS Setup ${NEXT_VERSION}.exe"
RELEASE_DIR="$ROOT_DIR/release/electron"

for required in "$INSTALLER_NAME" "$INSTALLER_NAME.blockmap" "latest.yml"; do
  if [ ! -f "$RELEASE_DIR/$required" ]; then
    echo "Expected release artifact missing: $RELEASE_DIR/$required" >&2
    exit 1
  fi
done

# ── 4. Deploy the live web/backend on the server ─────────────────────────
log "Deploying web/backend on ${SSH_HOST}:${APP_DIR}"
ssh "$SSH_HOST" bash -s <<REMOTE
set -euo pipefail
cd "$APP_DIR"
git fetch origin
git merge --ff-only origin/main
npm install --workspaces --if-present
npm run build

cd packages/backend
# Prisma's CLI auto-loads DATABASE_URL from packages/backend/.env - no need
# to parse it out ourselves (that .env stores it unquoted, unlike the other
# vars here, so a quote-delimited extraction silently produces an empty
# value and fails the "file:" scheme check).
npx prisma migrate deploy
cd "$APP_DIR"

pm2 restart "$PM2_APP" --update-env
pm2 status "$PM2_APP"
REMOTE

# ── 5. Publish the desktop update artifact ────────────────────────────────
log "Uploading the desktop installer to ${SSH_HOST}:${UPDATE_DIR}"
TMP_REMOTE_DIR="/tmp/jingles-pos-release-${NEXT_VERSION}"
ssh "$SSH_HOST" "mkdir -p '$TMP_REMOTE_DIR'"
scp \
  "$RELEASE_DIR/$INSTALLER_NAME" \
  "$RELEASE_DIR/$INSTALLER_NAME.blockmap" \
  "$RELEASE_DIR/latest.yml" \
  "$SSH_HOST:$TMP_REMOTE_DIR/"

ssh "$SSH_HOST" bash -s <<REMOTE
set -euo pipefail
sudo mv "$TMP_REMOTE_DIR"/* "$UPDATE_DIR"/
sudo chown root:root "$UPDATE_DIR/$INSTALLER_NAME" "$UPDATE_DIR/$INSTALLER_NAME.blockmap" "$UPDATE_DIR/latest.yml"
sudo chmod 644 "$UPDATE_DIR/$INSTALLER_NAME" "$UPDATE_DIR/$INSTALLER_NAME.blockmap" "$UPDATE_DIR/latest.yml"
rmdir "$TMP_REMOTE_DIR"
REMOTE

log "Release v${NEXT_VERSION} complete"
echo "Live site:      https://pos.theredsun.org"
echo "Desktop update: https://pos.theredsun.org/updates/pos (latest.yml -> ${INSTALLER_NAME})"
