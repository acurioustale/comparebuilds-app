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
#   1. an rsync --server push confined to the web root (the deploy), and
#   2. the post-deploy schema migration.
# Everything else is rejected.
#
# The rsync push is further constrained by four gates — push-only, no traversal,
# every path argument inside the web root, and an option allow-list (which
# decodes the short-flag bundle to reject -s) — plus --munge-links, which
# neutralises any smuggled symlink so it can't resolve out of the jail. The exact
# server-side option bundle varies by rsync version, so before installing a
# change here run one real `./deploy.sh --dry-run` against the host to confirm
# the jail still accepts the deploy's server command. See ops/README.md.
set -euf # -f: no globbing, so word-splitting the server args below is safe

# The single web root this key may write to. Both allow-listed commands are
# anchored to it, so the migration path and the rsync destination confinement
# can't drift apart. Keep it in sync with deploy.sh's TARGET.
WEBROOT="html/comparebuilds.app"

cmd="${SSH_ORIGINAL_COMMAND:-}"

reject() {
	echo "rsync-jail: ${1:-only rsync push allowed}" >&2
	exit 1
}

case "$cmd" in
# 1. Schema migration — exact match, no client-supplied arguments to inject.
"php ${WEBROOT}/api/cron/ensure_schema.php")
	exec /usr/bin/php "${WEBROOT}/api/cron/ensure_schema.php"
	;;

# 2. rsync server (receiver) only — a push INTO this account. The `--sender`
#    flag marks a pull/read, so rejecting it keeps this push-only.
rsync\ --server\ --sender\ *)
	reject "pull not allowed"
	;;
rsync\ --server\ *)
	# Reject `..` but only as a path component — bounded by `/` or an argument
	# boundary — not as a bare substring. A substring test (`*..*`) also trips on
	# a legitimate filename like `foo..bar.png`, and public/talent-icons/ carries
	# upstream-derived names, so that false reject would abort a real deploy.
	# Splitting on whitespace first keeps the boundary logic to just `/` and the
	# token ends; set -f (above) makes the unquoted split safe.
	#
	# Also reject any token carrying a backslash. Every gate here and the final
	# exec split $cmd on whitespace identically, so there is no validate/exec
	# skew — but a path with whitespace or a shell metachar arrives
	# backslash-escaped from rsync (`foo\ bar`) and splits into fragments, which
	# would then fail the destination gate below with a misleading "outside the
	# web root" message. This jail supports only whitespace-free paths (the
	# deploy set is), so reject an escaped token outright with a clear reason
	# rather than mis-parsing it. A legitimate deploy token (an option, `.`, or
	# the fixed html/comparebuilds.app/… dest) never contains a backslash.
	# shellcheck disable=SC2086
	set -- ${cmd#rsync --server }
	for arg in "$@"; do
		case "$arg" in
		.. | ../* | */.. | */../*) reject "path traversal rejected" ;;
		*\\*) reject "escaped whitespace/special chars in paths not supported" ;;
		esac
	done

	# Confine the write to the web root. rsync roots the receiver at a
	# client-supplied destination argument — a push-only jail that never checks
	# it still lets a compromised key aim the transfer at ~/.ssh/authorized_keys,
	# ~/bin (this very script), or ../config.php (the DB creds one level above
	# the web root), or add --delete to wipe files elsewhere.
	#
	# EVERY positional path argument is checked, not just the last: options and
	# the short-flag bundle carry a leading dash, `.` is rsync's source
	# placeholder for a receiver, and everything else is a destination. Checking
	# only the trailing token (${cmd##* }) would let an extra interior path like
	# `. /home/www/web4186/bin/ html/comparebuilds.app/` slip past behind a
	# benign trailing dest — rsync --server can treat the extra token as a second
	# destination root.
	for arg in "$@"; do
		case "$arg" in
		-*) : ;; # option or short-flag bundle (vetted by the allow-list below)
		. | "${WEBROOT}" | "${WEBROOT}/"*) : ;;
		*) reject "destination outside ${WEBROOT}" ;;
		esac
	done

	# Allow-list the options rsync may pass. deploy.sh sends one short-flag bundle
	# plus the long option --delete (GNU rsync folds --dry-run into the short
	# bundle); refuse any other long option (--rsync-path, --files-from,
	# --remove-source-files, extra --delete-* modes, …) so a key holder can't
	# smuggle a dangerous receiver option past the destination check above.
	# --chmod is deliberately NOT allow-listed, and deploy.sh's --chmod=D755,F644
	# does not need it to be: rsync's server_options() never forwards --chmod on
	# a push (it is applied to the file list on the sending side), so it never
	# appears in the server command vetted here. What the allow-list refuses is
	# therefore only a smuggled one — on this shared host a --chmod=D777,F666
	# would make the web root world-writable. Do not add an entry to "match"
	# deploy.sh; if some future deploy really does send one, pin the exact
	# literal rather than --chmod=*.
	#
	# A short-flag bundle (single dash) can express one dangerous receiver option
	# the long-option allow-list never sees: -s (--secluded-args, formerly
	# --protect-args). With it, rsync sends the real file and destination paths
	# over the protocol stream instead of on the command line, so the traversal
	# and destination gates above would validate a benign decoy while the
	# receiver acts on attacker-controlled paths — defeating the jail entirely.
	# rrsync guards this by decoding short flags; do the same here. The
	# legitimate deploy bundle looks like -vlogDtprze.iLsfxCIvu (with an `n` for
	# --dry-run): the `s` for secluded-args sits in the pre-`.` cluster of real
	# short flags, while the post-`.` modifier section (.iLsfxCIvu) legitimately
	# carries an `s` — so inspect only the part before the first dot.
	for arg in "$@"; do
		case "$arg" in
		--delete) : ;;
		--*) reject "option not allowed: $arg" ;;
		-?*)
			case "${arg%%.*}" in
			*s*) reject "secluded-args (-s) not allowed: $arg" ;;
			esac
			;;
		esac
	done

	# Neutralise symlinks: --munge-links prefixes any incoming symlink target so
	# it can never resolve outside the jail (a no-op for the symlink-free deploy
	# set). This closes the one escalation the checks above don't — a symlink
	# written into the web root that Apache would otherwise follow out of the jail.
	# shellcheck disable=SC2086
	exec rsync --server --munge-links ${cmd#rsync --server }
	;;

*)
	reject
	;;
esac
