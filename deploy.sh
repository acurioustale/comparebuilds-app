#!/usr/bin/env bash
#
# Production deploy for comparebuilds.app.
#
# Assembles the served tree from two sources and rsyncs it to the shared
# Core Networks host over ssh:
#   - dist/                         the built static site (run `npm run build` first)
#   - api/{share.php,og.php,fonts}  the PHP share API + Open Graph image renderer
#
# config.php (the DB credentials) lives one level ABOVE the web root and is
# never touched here. The CI deploy key is rrsync-restricted to the web root,
# so it cannot reach above it anyway.
#
# In CI the key is restricted to the web root, so the destination path is
# relative to it and DEPLOY_DEST stays empty. To run this by hand over password
# auth, point DEPLOY_DEST at the absolute web root:
#   DEPLOY_DEST=/home/www/web4186/html/comparebuilds.app/ ./deploy.sh --dry-run
#
# Any arguments (e.g. --dry-run) are passed straight through to rsync.

set -euo pipefail

cd "$(dirname "$0")"

REMOTE="${DEPLOY_REMOTE:-web4186@http2.core-networks.de}"
DEST="${DEPLOY_DEST:-}"

if [[ ! -f dist/index.html ]]; then
  echo "error: dist/index.html not found - run 'npm run build' first." >&2
  exit 1
fi

# Stage the exact tree the web root should contain, so a single --delete pass
# mirrors it without ever wiping the API folder (which is not part of dist/).
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cp -a dist/. "$stage/"
mkdir -p "$stage/api"
cp -a api/share.php api/og.php api/fonts "$stage/api/"

echo "==> Deploying to ${REMOTE}:${DEST:-<web root>}"
rsync -avz --delete --human-readable \
  --exclude '.git' --exclude '.claude' --exclude 'deploy.sh' \
  "$@" \
  "$stage/" "${REMOTE}:${DEST}"

echo "==> Done."
