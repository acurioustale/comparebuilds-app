# ops/

Operational configuration that is **not** part of the deployed site and is
**not** run by CI or `deploy.sh`. Files here are reviewed reference copies of
things installed by hand on the web host, kept in version control so they can be
reviewed, diffed and restored. Shell scripts here are still linted, though:
`validate.sh` and CI discover every tracked `*.sh` (via `git ls-files`), so
shellcheck and shfmt catch a shell bug in the reviewed copy before it is
hand-copied to the host.

## `rsync-jail-comparebuilds.sh`

The forced command that jails the CI deploy key on the host. It is pinned to the
`comparebuilds-deploy` key in the `web4186` account's `~/.ssh/authorized_keys`,
with `restrict` (OpenSSH's umbrella flag disabling the pty, agent, port and X11
forwarding, and user-rc):

```text
command="/home/www/web4186/bin/rsync-jail-comparebuilds.sh",restrict ssh-ed25519 <public key> comparebuilds-deploy
```

It allow-lists exactly the two SSH commands `deploy.sh` issues: an `rsync`
_push_ into `html/comparebuilds.app/`, and the post-deploy schema migration
(`php html/comparebuilds.app/api/cron/ensure_schema.php`, an exact string match
with no client-supplied arguments). No shell, no pull, anything else rejected.
This is what makes the `DEPLOY_SSH_KEY` secret harmless if leaked.

The push is constrained by four gates plus one injected option:

- **Push-only** — `rsync --server --sender` (a pull/read) is refused.
- **No traversal** — `..` is rejected as a path _component_ (`.. | ../* | */..
| */../*`) per whitespace-split token, not as a bare substring: a substring
  test also trips on a legitimate filename like `foo..bar.png`, and
  `public/talent-icons/` carries upstream-derived names. Tokens carrying a
  backslash are refused outright, because an escaped path (`foo\ bar`) would
  split into fragments and fail the destination gate with a misleading message.
- **Destination inside the web root** — _every_ positional argument is checked,
  not just the last. Options and the short-flag bundle carry a leading dash and
  `.` is rsync's source placeholder; everything else must start with
  `html/comparebuilds.app`. Checking only the trailing token would let an extra
  interior destination slip past behind a benign trailing one, since
  `rsync --server` can treat it as a second destination root.
- **Option allow-list** — `--delete` is the only long option permitted; any
  other (`--rsync-path`, `--files-from`, `--remove-source-files`, extra
  `--delete-*` modes, …) is refused. `--chmod` is deliberately not allow-listed:
  this deploy sends none, and on this shared host a smuggled `--chmod=D777,F666`
  would make the web root world-writable. If `deploy.sh` ever starts sending
  one, pin the exact literal rather than `--chmod=*`. The short-flag bundle is
  decoded too, to reject `-s` (`--secluded-args`), which would otherwise move
  the real paths off the command line into the protocol stream, where the
  traversal and destination gates cannot see them at all. Only the part of the
  bundle before the first dot is inspected — the post-dot modifier section
  legitimately carries an `s`.
- **`--munge-links` injected** — a symlink written into the web root can never
  resolve outside the jail when Apache serves it.

The destination is pinned to that subdirectory rather than the account root
because the host account is shared with other sites' deploy keys, each confined
to its own jail script.

### Verifying a change

The server-side option bundle rsync generates varies by rsync version, so a
change to the option allow-list (or to any gate that reads those arguments) must
be proven against the host before it is installed: run one real
`./deploy.sh --dry-run` and confirm it is not rejected.

### Installing a change

**Reviewed source, manually installed by an admin; the server file is
authoritative.** CI does not install this file, and the jailed key cannot write
`~/bin`, so the deploy can neither install nor verify it. Changing the jail's
behaviour means updating this copy _and_ copying it to the host; the two can
drift, and the host wins:

```bash
scp ops/rsync-jail-comparebuilds.sh web4186@http2.core-networks.de:bin/
```

If `deploy.sh` ever issues a new remote SSH command (anything beyond the current
`rsync` push and schema migration), it needs a matching allow-entry added here
_and_ on the host, or the forced command rejects it with
`rsync-jail: only rsync push allowed`.
