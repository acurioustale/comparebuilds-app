#!/usr/bin/env bash
# Deploy comparebuilds.app to the web host via rsync over ssh.
# Usage: ./deploy.sh [--dry-run]   (extra args pass through to rsync)
#
# The served tree comes from two places, so we stage them into one directory
# and mirror that with a single --delete pass:
#   - dist/                         the built static site (run `npm run build` first)
#   - api/{share.php,og.php,fonts}  the PHP share API + Open Graph image renderer
#
# Staging keeps --delete from wiping the live api/ folder (which is not part of
# dist/). config.php (the DB credentials) lives one level ABOVE the web root and
# is left untouched. The CI key is confined to TARGET server-side by a forced-
# command rsync jail (~/bin/rsync-jail-comparebuilds.sh), so it cannot write
# anywhere else in the shared account; the jail expects this home-relative path.
set -euo pipefail

cd "$(dirname "$0")"

REMOTE="web4186@http2.core-networks.de"
TARGET="html/comparebuilds.app/"

if [[ ! -f dist/index.html ]]; then
	echo "error: dist/index.html not found - run 'npm run build' first." >&2
	exit 1
fi

stage="$(mktemp -d)"
# mktemp -d makes the staging dir 0700. The rsync below mirrors this directory
# with -a (which preserves permissions), so that mode would be copied onto the
# web root and lock Apache out (403, "unable to read .htaccess file"). Make the
# staging root web-readable so the deploy keeps the web root at 0755 (and heals
# a root previously left at 0700).
chmod 755 "$stage"
trap 'rm -rf "$stage"' EXIT

cp -a dist/. "$stage/"
mkdir -p "$stage/api"
cp -a api/share.php api/og.php api/fonts api/cron "$stage/api/"

rsync -avz --delete "$@" \
	--exclude '.git' \
	--exclude '.claude' \
	--exclude 'deploy.sh' \
	"$stage/" \
	"${REMOTE}:${TARGET}"

if [[ "$*" != *"--dry-run"* ]]; then
	echo "Running schema migration..."
	# shellcheck disable=SC2029
	ssh "${REMOTE}" "php ${TARGET}api/cron/ensure_schema.php" || true
fi
