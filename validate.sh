#!/usr/bin/env bash
# Run the full CI gate locally, in the same order as .github/workflows/ci.yml:
# lint -> coverage (enforces the thresholds in vite.config.js) -> build. A green
# run here is exactly what CI checks on push/PR, so use it as the pre-push gate.
#
# Usage: ./validate.sh [--clean]
#   --clean   reinstall dependencies with `npm ci` first, matching CI's clean
#             install. Omit it to reuse the existing node_modules (faster); pass
#             it when package-lock.json changed or a dependency issue is suspected.
set -euo pipefail

cd "$(dirname "$0")"

do_clean=0
case "${1:-}" in
"") ;;
--clean) do_clean=1 ;;
*)
	echo "usage: ./validate.sh [--clean]" >&2
	exit 2
	;;
esac

# CI pins Node 22. Warn (don't block) on a mismatch: a different engine can pass
# here yet behave differently in CI.
ci_node_major=22
local_node_major="$(node -v | sed 's/^v//; s/\..*//')"
if [[ "$local_node_major" != "$ci_node_major" ]]; then
	echo "warning: local Node is v$local_node_major, CI uses v$ci_node_major." >&2
fi

# Versions of the brew-installed CLIs pinned in .github/workflows/deploy.yml.
# Mirrored here so a local tool that has drifted from CI is caught before push
# instead of surfacing as a mystery formatting/lint failure in the pipeline.
# Keep in sync with deploy.yml. (Prettier and the other npm tools aren't listed:
# they're pinned by package-lock.json and `npm ci`, so local always matches CI.)
SHFMT_VERSION="3.13.1"
PHPCSFIXER_VERSION="3.95.10"
ACTIONLINT_VERSION="1.7.12"

# Assert a present tool reports the pinned version; the needle is matched
# literally so the surrounding "v"/extra output in --version lines doesn't
# matter. Only called inside the command -v guards below, so an absent tool
# still skips gracefully rather than failing the version check.
require_version() {
	local name="$1" want="$2" got="$3"
	case "$got" in
	*"$want"*) ;;
	*)
		echo "  $name version mismatch: want $want, got: $got" >&2
		echo "  install the pinned version (see deploy.yml) so local matches CI" >&2
		exit 1
		;;
	esac
}

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if [[ "$do_clean" -eq 1 ]]; then
	step "Install (npm ci)"
	npm ci
fi

# Shell scripts: shellcheck for correctness, shfmt (defaults) for formatting.
# Skipped with a notice when the tools aren't installed locally so validate.sh
# stays runnable everywhere; CI always enforces them. When present, either tool's
# findings fail the run via set -e.
if command -v shellcheck >/dev/null && command -v shfmt >/dev/null; then
	step "Shell scripts (shellcheck + shfmt)"
	require_version shfmt "$SHFMT_VERSION" "$(shfmt --version)"
	shellcheck ./*.sh
	shfmt -d ./*.sh
else
	echo "note: shellcheck/shfmt not installed - skipping shell checks (CI enforces them)." >&2
fi

# PHP: syntax check the share API + OG renderer (and the config template). Guarded
# like the shell checks; CI always runs it.
if command -v php >/dev/null; then
	step "PHP syntax (php -l)"
	while IFS= read -r f; do php -l "$f"; done < <(git ls-files '*.php' '*.php.example')
else
	echo "note: php not installed - skipping PHP checks (CI enforces them)." >&2
fi

if command -v php-cs-fixer >/dev/null; then
	step "PHP format (php-cs-fixer)"
	require_version php-cs-fixer "$PHPCSFIXER_VERSION" "$(php-cs-fixer --version)"
	php-cs-fixer fix --dry-run --config .php-cs-fixer.dist.php
else
	echo "note: php-cs-fixer not installed - skipping (CI enforces it)." >&2
fi

if command -v phpunit >/dev/null; then
	step "PHP tests (phpunit)"
	phpunit
else
	echo "note: phpunit not installed - skipping (CI enforces it)." >&2
fi

if command -v actionlint >/dev/null; then
	step "Workflows (actionlint)"
	require_version actionlint "$ACTIONLINT_VERSION" "$(actionlint --version | head -1)"
	actionlint
else
	echo "note: actionlint not installed - skipping (CI enforces it)." >&2
fi

step "Lint"
npm run lint

step "Format (Prettier)"
npm run format:check

step "CSS (stylelint)"
npm run lint:css

step "Markdown (markdownlint)"
npm run lint:md

step "SVG (svgo)"
npm run lint:svg

step "Tests + coverage thresholds"
npm run coverage

step "Build"
npm run build

# Verify the CSP hash for the inline anti-flash theme script still matches the
# built script's bytes — runs against dist/ so it checks exactly what ships.
step "CSP guard"
npm run check:csp

# Validate the freshly built sitemap is well-formed XML — the surest guard against
# a templating bug in prerenderSpecs (e.g. an unescaped character in a URL). Plain
# --noout is well-formedness only (no network). xmllint comes from libxml2-utils:
# bundled on macOS, but NOT on the CI runner image (the workflow apt-installs it
# there). Guarded like the other non-npm CLIs above: skipped with a notice when
# absent so validate.sh stays runnable everywhere; CI always enforces it.
if command -v xmllint >/dev/null; then
	step "Sitemap (xmllint)"
	xmllint --noout dist/sitemap.xml
else
	echo "note: xmllint not installed - skipping sitemap check (CI enforces it)." >&2
fi

step "All CI checks passed."
