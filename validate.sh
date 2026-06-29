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

# Versions pinned in .tool-versions. Asserted here (only when the tool is
# present) so a drifted local tool is caught before it surfaces as a mystery
# failure in CI. .tool-versions is the single source of truth.
tool_version() {
	grep "^$1 " .tool-versions | awk '{print $2}'
}
ci_node_version="$(tool_version nodejs)"
SHFMT_VERSION="$(tool_version shfmt)"
PHPCSFIXER_VERSION="$(tool_version php-cs-fixer)"
PHPUNIT_VERSION="$(tool_version phpunit)"
ACTIONLINT_VERSION="$(tool_version actionlint)"

have() { command -v "$1" >/dev/null 2>&1; }
skip() { echo "note: $1 not installed - skipping $2 (CI enforces it)." >&2; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

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

# CI pins Node. Warn (don't block) on a mismatch: a different engine can pass
# here yet behave differently in CI.
ci_node_major="${ci_node_version%%.*}"
local_node_major="$(node -v | sed 's/^v//; s/\..*//')"
if [[ "$local_node_major" != "$ci_node_major" ]]; then
	echo "warning: local Node is v$local_node_major, CI uses v$ci_node_major." >&2
fi

if [[ "$do_clean" -eq 1 ]]; then
	step "Install (npm ci)"
	npm ci
fi

# Shell scripts: shellcheck for correctness, shfmt (defaults) for formatting.
# Skipped with a notice when the tools aren't installed locally so validate.sh
# stays runnable everywhere; CI always enforces them. When present, either tool's
# findings fail the run via set -e.
if have shellcheck && have shfmt; then
	step "Shell scripts (shellcheck + shfmt)"
	require_version shfmt "$SHFMT_VERSION" "$(shfmt --version)"
	sh_files=()
	while IFS= read -r -d '' file; do
		sh_files+=("$file")
	done < <(find . -maxdepth 1 -name "*.sh" -print0)
	shellcheck "${sh_files[@]}"
	shfmt -d "${sh_files[@]}"
else
	skip shellcheck/shfmt "shell checks"
fi

# PHP: syntax check the share API + OG renderer (and the config template). Guarded
# like the shell checks; CI always runs it.
if have php; then
	step "PHP syntax (php -l)"
	while IFS= read -r f; do php -l "$f"; done < <(git ls-files '*.php' '*.php.example')
else
	skip php "PHP checks"
fi

if have php-cs-fixer; then
	step "PHP format (php-cs-fixer)"
	require_version php-cs-fixer "$PHPCSFIXER_VERSION" "$(php-cs-fixer --version)"
	php-cs-fixer fix --dry-run --config .php-cs-fixer.dist.php
else
	skip php-cs-fixer "php-cs-fixer"
fi

if have phpunit; then
	step "PHP tests (phpunit)"
	require_version phpunit "$PHPUNIT_VERSION" "$(phpunit --version | head -1)"
	phpunit
else
	skip phpunit "phpunit"
fi

if have actionlint; then
	step "Workflows (actionlint)"
	require_version actionlint "$ACTIONLINT_VERSION" "$(actionlint --version | head -1)"
	actionlint
else
	skip actionlint "actionlint"
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
# Run svgo into a temp file so a svgo crash (bad fetch, config error) is
# distinguished from a genuinely unoptimised SVG, instead of pipefail turning
# both into the same misleading "not optimised" message.
svgo_out="$(mktemp)"
trap 'rm -f "$svgo_out"' EXIT
f="public/favicon.svg"
if ! npx svgo -i "$f" -o "$svgo_out" >/dev/null; then
	echo "  svgo failed to process $f"
	exit 1
fi
if ! diff -q "$svgo_out" "$f" >/dev/null; then
	echo "  $f is not optimised; run: npx svgo $f"
	exit 1
fi

step "Tests + coverage thresholds"
npm run coverage

step "Build"
npm run build

# Verify the CSP hash for the inline anti-flash theme script still matches the
# built script's bytes — runs against dist/ so it checks exactly what ships.
step "CSP guard"
npm run check:csp

step "OG image guard"
npm run check:og

# Validate the freshly built sitemap is well-formed XML — the surest guard against
# a templating bug in prerenderSpecs (e.g. an unescaped character in a URL). Plain
# --noout is well-formedness only (no network). xmllint comes from libxml2-utils:
# bundled on macOS, but NOT on the CI runner image (the workflow apt-installs it
# there). Guarded like the other non-npm CLIs above: skipped with a notice when
# absent so validate.sh stays runnable everywhere; CI always enforces it.
if have xmllint; then
	step "Sitemap (xmllint)"
	xmllint --noout dist/sitemap.xml
else
	skip xmllint "sitemap check"
fi

step "All CI checks passed."
