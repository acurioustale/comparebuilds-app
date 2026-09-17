#!/usr/bin/env bash
# Deploy comparebuilds.app to the web host via rsync over ssh.
# Usage: ./deploy.sh [--dry-run]   (--dry-run is the only accepted argument)
#
# The served tree comes from two places, so we stage them into one directory
# and mirror that with a single --delete pass:
#   - dist/                              the built static site (run `npm run build` first)
#   - api/{share.php,og.php,lib,fonts,cron,current_layouts.json}  the PHP share
#                                        API + OG renderer + its shared classes
#                                        (lib/), cron scripts, and the build-
#                                        generated current-layouts manifest that
#                                        ensure_schema.php reconciles into the DB
#
# The two halves are staged differently on purpose: dist/ is a build product and
# untracked, so disk is its only source; api/ is tracked source and is read out
# of HEAD, so a hand-run deploy from a dirty checkout cannot publish uncommitted
# PHP to the internet-facing half of the site.
#
# Staging keeps --delete from wiping the live api/ folder (which is not part of
# dist/). config.php (the DB credentials) lives one level ABOVE the web root and
# is left untouched. The CI key is confined to TARGET server-side by a forced-
# command rsync jail (~/bin/rsync-jail-comparebuilds.sh), so it cannot write
# anywhere else in the shared account; the jail expects this home-relative path.
set -euo pipefail

cd "$(dirname "$0")"

# Every api/ path the served tree needs. dist/ ships whole, but api/ is picked
# from a working tree that also holds files the site must NOT serve, so this list
# is hand-maintained — and `rsync --delete` then removes server-side whatever is
# missing from it, which either fatals every share/OG request or silently breaks
# a cron job. tools/check-deploy-assets.mjs binds this array to the tracked api/
# tree (every file classified ship-or-not) and to each PHP file's own requires,
# so a forgotten runtime dependency fails the gate instead of the deploy. Keep it
# a single one-line array literal: that guard parses it. Entries are `git archive`
# pathspecs (see below), so keep them plain literal paths - no glob or pathspec
# magic, which would resolve differently there than the guard resolves it here.
API_ASSETS=(api/share.php api/og.php api/lib api/fonts api/cron api/current_layouts.json)
# The subset of API_ASSETS the BUILD writes rather than git tracking. Those are
# gitignored, so they are absent from HEAD and must be staged from disk — passing
# one to `git archive` as a pathspec would match nothing and abort the whole
# archive. Keep this a single one-line array literal too: the guard parses it as
# well, so the split it reasons about is the split the deploy performs.
API_GENERATED=(api/current_layouts.json)

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

# dist/ is a build product and untracked, so it can only be staged from disk —
# `npm run build` above is what makes it authoritative.
cp -a dist/. "$stage/"

# api/ is tracked source, so it is staged from the COMMIT, not the working tree.
# Reading each path off disk meant a hand-run deploy from a dirty checkout
# published uncommitted PHP to a public endpoint; `git archive` reads the blobs
# out of HEAD instead, so what ships is exactly what is committed, matching what
# CI deploys from a clean checkout. API_ASSETS entries are already api/-prefixed,
# so they extract straight to $stage/api/... (which is why no mkdir is needed).
# A pathspec matching nothing in HEAD (a typo'd or renamed entry) aborts the
# archive, keeping that a loud failure rather than a silently empty ship.
archive_paths=()
for asset in "${API_ASSETS[@]}"; do
	generated=0
	for gen in "${API_GENERATED[@]}"; do
		if [[ "$asset" == "$gen" ]]; then
			generated=1
			break
		fi
	done
	if [[ "$generated" -eq 0 ]]; then
		archive_paths+=("$asset")
	fi
done
if [[ "${#archive_paths[@]}" -eq 0 ]]; then
	# git archive with no pathspec would archive the WHOLE repo into the web root.
	echo "error: no tracked api/ paths to stage - check API_ASSETS/API_GENERATED." >&2
	exit 1
fi
git archive --format=tar HEAD -- "${archive_paths[@]}" | tar -x -C "$stage"

# The generated half is not in HEAD by design, so it comes off disk like dist/.
if [[ "${#API_GENERATED[@]}" -gt 0 ]]; then
	cp -a "${API_GENERATED[@]}" "$stage/api/"
fi

# Publishing HEAD means local edits to api/ are ignored; say so, or a hand-run
# deploy from a dirty tree looks like it shipped what is on screen.
if ! git diff --quiet HEAD -- "${API_ASSETS[@]}"; then
	echo "==> Note: uncommitted changes to api/ are NOT deployed (shipping HEAD)" >&2
fi

rsync_args=()
is_dry_run=0
for arg in "$@"; do
	case "$arg" in
	--dry-run)
		rsync_args+=("--dry-run")
		is_dry_run=1
		;;
	*)
		echo "Usage: ./deploy.sh [--dry-run]" >&2
		exit 1
		;;
	esac
done

if [[ "${#rsync_args[@]}" -gt 0 ]]; then
	rsync -avz --delete "${rsync_args[@]}" \
		--exclude '.git' \
		--exclude '.claude' \
		--exclude 'deploy.sh' \
		"$stage/" \
		"${REMOTE}:${TARGET}"
else
	rsync -avz --delete \
		--exclude '.git' \
		--exclude '.claude' \
		--exclude 'deploy.sh' \
		"$stage/" \
		"${REMOTE}:${TARGET}"
fi

if [[ "$is_dry_run" -eq 0 ]]; then
	echo "Running schema migration..."
	# shellcheck disable=SC2029
	if ! ssh "${REMOTE}" "php ${TARGET}api/cron/ensure_schema.php"; then
		echo "error: schema migration failed - files were deployed but the DB schema may be stale." >&2
		exit 1
	fi
fi
