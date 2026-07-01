#!/bin/sh
# rsync-jail-comparebuilds.sh — forced command confining the comparebuilds CI
# deploy key.
#
# Installed on the deploy host at ~/bin/rsync-jail-comparebuilds.sh and pinned to
# the comparebuilds-deploy key in that account's ~/.ssh/authorized_keys (the
# `restrict` option disables pty, port/agent/X11 forwarding, and user-rc):
#
#   command="/home/www/web4186/bin/rsync-jail-comparebuilds.sh",restrict ssh-ed25519 <public key> comparebuilds-deploy
#
# This file is the REVIEWED SOURCE; the copy on the server is what runs. The
# jailed key can only rsync into the web root — it cannot write ~/bin — so the
# deploy can neither install nor verify this script. After changing it here, an
# admin with full account access must copy it into place manually:
#
#   scp ops/rsync-jail-comparebuilds.sh web4186@http2.core-networks.de:bin/
#
# It allow-lists EXACTLY the SSH commands deploy.sh issues. If you add a new
# `ssh "$REMOTE" "..."` call to deploy.sh, add a matching case here and reinstall,
# or the deploy fails with "rsync-jail: only rsync push allowed". Permits exactly:
#   1. an rsync --server push (the deploy), and
#   2. the post-deploy schema migration.
# Everything else is rejected.
set -eu

cmd="${SSH_ORIGINAL_COMMAND:-}"

case "$cmd" in
# 1. Schema migration — exact match, no client-supplied arguments to inject.
"php html/comparebuilds.app/api/cron/ensure_schema.php")
	exec /usr/bin/php html/comparebuilds.app/api/cron/ensure_schema.php
	;;

# 2. rsync server (receiver) only — a push INTO this account. The `--sender`
#    flag marks a pull/read, so rejecting it keeps this push-only.
rsync\ --server\ --sender\ *)
	echo "rsync-jail: only rsync push allowed" >&2
	exit 1
	;;
rsync\ --server\ *)
	# Word-splitting is intentional: rsync's own args must be passed through.
	# shellcheck disable=SC2086
	exec $SSH_ORIGINAL_COMMAND
	;;

*)
	echo "rsync-jail: only rsync push allowed" >&2
	exit 1
	;;
esac
