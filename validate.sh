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
# failure in CI. .tool-versions is the single source of truth; read each pin
# through one helper that matches the whole tool name (so "php" can't match
# "php-cs-fixer") rather than a prefix regex.
tool_version() { awk -v tool="$1" '$1 == tool {print $2}' .tool-versions; }
ci_node_version="$(tool_version nodejs)"
ci_php_version="$(tool_version php)"
SHFMT_VERSION="$(tool_version shfmt)"
PHPCSFIXER_VERSION="$(tool_version php-cs-fixer)"
PHPUNIT_VERSION="$(tool_version phpunit)"
ACTIONLINT_VERSION="$(tool_version actionlint)"

have() { command -v "$1" >/dev/null 2>&1; }
skip() { echo "note: $1 not installed - skipping $2 (CI enforces it)." >&2; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# Assert a tool reports the pinned version. Pull the dotted version token out of
# the --version line (so a leading "v" or trailing extra output doesn't matter)
# and require it to equal the pin exactly. A substring test would wrongly accept
# a superstring - e.g. shfmt 3.13.10 contains the pinned 3.13.1. Only called
# inside the command -v guards below, so an absent tool still skips gracefully
# rather than failing the version check.
require_version() {
	local name="$1" want="$2" got="$3" found=""
	[[ "$got" =~ ([0-9]+(\.[0-9]+)+) ]] && found="${BASH_REMATCH[1]}"
	if [[ "$found" != "$want" ]]; then
		echo "  $name version mismatch: want $want, got: $got" >&2
		echo "  install the pinned version (see .tool-versions) so local matches CI" >&2
		exit 1
	fi
}

# ─── Pinned tools ───────────────────────────────────────────────────────────
# CI never takes these from a package manager: it downloads the exact pinned
# release on every run. Mirror that locally into .tools/ (gitignored, cached per
# version) so a routine `brew upgrade` can't drift a tool out from under its pin
# - the pins belong to the project, not to the machine. Falls back to the PATH
# copy, still version-asserted, when the download is unavailable, so an offline
# machine degrades to the old behaviour instead of blocking. Bounded and
# fail-fast: a stalled release host costs seconds and a fallback, not the run.
TOOLS_DIR=.tools

# pinned_fetch <dest> <url> [tar-member]. With a member the asset is a .tar.gz
# and that entry is extracted; without one it is the executable itself.
pinned_fetch() {
	local dest="$1" url="$2" member="${3:-}" tmp
	[[ -x "$dest" ]] && return 0
	have curl || return 1
	tmp="$(mktemp -d)" || return 1
	if ! curl -sSfL --retry 2 --retry-delay 1 --retry-all-errors --max-time 60 "$url" -o "$tmp/dl"; then
		rm -rf "$tmp"
		return 1
	fi
	if [[ -n "$member" ]]; then
		if ! tar xzf "$tmp/dl" -C "$tmp" "$member"; then
			rm -rf "$tmp"
			return 1
		fi
		mv "$tmp/$member" "$tmp/dl"
	fi
	mkdir -p "$TOOLS_DIR"
	chmod +x "$tmp/dl"
	mv "$tmp/dl" "$dest"
	rm -rf "$tmp"
}

# Release-asset naming for this machine. The phars are platform-independent; the
# two Go binaries are not. An unrecognised CPU leaves the slug empty, the URL
# 404s, and the PATH fallback takes over.
tools_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in
x86_64) tools_cpu=amd64 ;;
arm64 | aarch64) tools_cpu=arm64 ;;
*) tools_cpu="" ;;
esac

# Resolve each pinned tool to a command array: the cached pinned copy when we can
# get it, else the PATH copy, else empty so the stage skips as it always has.
shfmt_cmd=()
if pinned_fetch "$TOOLS_DIR/shfmt-$SHFMT_VERSION" \
	"https://github.com/mvdan/sh/releases/download/v$SHFMT_VERSION/shfmt_v${SHFMT_VERSION}_${tools_os}_${tools_cpu}"; then
	shfmt_cmd=("$TOOLS_DIR/shfmt-$SHFMT_VERSION")
elif have shfmt; then
	require_version shfmt "$SHFMT_VERSION" "$(shfmt --version)"
	shfmt_cmd=(shfmt)
fi

actionlint_cmd=()
if pinned_fetch "$TOOLS_DIR/actionlint-$ACTIONLINT_VERSION" \
	"https://github.com/rhysd/actionlint/releases/download/v$ACTIONLINT_VERSION/actionlint_${ACTIONLINT_VERSION}_${tools_os}_${tools_cpu}.tar.gz" actionlint; then
	actionlint_cmd=("$TOOLS_DIR/actionlint-$ACTIONLINT_VERSION")
elif have actionlint; then
	require_version actionlint "$ACTIONLINT_VERSION" "$(actionlint --version | head -1)"
	actionlint_cmd=(actionlint)
fi

# The phars are run as `php <phar>`, exactly as CI invokes them - a shell wrapper
# on PATH breaks php-cs-fixer's parallel runner, which re-execs itself and cannot
# resolve its own path through the wrapper.
phpcsfixer_cmd=()
if have php && pinned_fetch "$TOOLS_DIR/php-cs-fixer-$PHPCSFIXER_VERSION.phar" \
	"https://github.com/PHP-CS-Fixer/PHP-CS-Fixer/releases/download/v$PHPCSFIXER_VERSION/php-cs-fixer.phar"; then
	phpcsfixer_cmd=(php "$TOOLS_DIR/php-cs-fixer-$PHPCSFIXER_VERSION.phar")
elif have php-cs-fixer; then
	require_version php-cs-fixer "$PHPCSFIXER_VERSION" "$(php-cs-fixer --version)"
	phpcsfixer_cmd=(php-cs-fixer)
fi

phpunit_cmd=()
if have php && pinned_fetch "$TOOLS_DIR/phpunit-$PHPUNIT_VERSION.phar" \
	"https://phar.phpunit.de/phpunit-$PHPUNIT_VERSION.phar"; then
	phpunit_cmd=(php "$TOOLS_DIR/phpunit-$PHPUNIT_VERSION.phar")
elif have phpunit; then
	require_version phpunit "$PHPUNIT_VERSION" "$(phpunit --version | head -1)"
	phpunit_cmd=(phpunit)
fi

# CI pins Node through this same file, so a local mismatch means the JS stages
# below prove nothing about CI. Block on it, as every other pin does - a warning
# scrolls past on a script this long. Only the major is compared: setup-node
# resolves the pin to the latest matching release, so an exact match is not
# something a local install can be held to.
ci_node_major="${ci_node_version%%.*}"
local_node_major="$(node -v | sed 's/^v//; s/\..*//')"
if [[ "$local_node_major" != "$ci_node_major" ]]; then
	echo "  Node version mismatch: want v$ci_node_major, got: $(node -v)" >&2
	echo "  install the pinned version (see .tool-versions) so local matches CI" >&2
	exit 1
fi

# PHP is the one runtime that also serves production, so the pin tracks the live
# server (8.4 is the latest it supports) and both CI and this script must agree
# with it - a syntax check or a test suite passing on a newer PHP says nothing
# about the engine the API actually runs on. Compare major.minor: the patch
# release is whatever the local package manager and setup-php each resolve to.
# Guarded like the PHP stages below, so a machine without PHP still skips them
# rather than failing on a version it was never going to run.
if have php; then
	local_php_version="$(php -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;')"
	if [[ "$local_php_version" != "$ci_php_version" ]]; then
		echo "  PHP version mismatch: want $ci_php_version, got: $local_php_version" >&2
		echo "  install the pinned version (see .tool-versions) so local matches CI" >&2
		exit 1
	fi
fi

if [[ "$do_clean" -eq 1 ]]; then
	step "Install (npm ci)"
	npm ci
fi

# Shell scripts: shellcheck for correctness, shfmt (defaults) for formatting.
# Skipped with a notice when the tools aren't installed locally so validate.sh
# stays runnable everywhere; CI always enforces them. When present, either tool's
# findings fail the run via set -e.
if have shellcheck && [[ ${#shfmt_cmd[@]} -gt 0 ]]; then
	step "Shell scripts (shellcheck + shfmt)"
	sh_files=()
	while IFS= read -r file; do
		sh_files+=("$file")
	done < <(git ls-files '*.sh')
	shellcheck "${sh_files[@]}"
	"${shfmt_cmd[@]}" -d "${sh_files[@]}"
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

if [[ ${#phpcsfixer_cmd[@]} -gt 0 ]]; then
	step "PHP format (php-cs-fixer)"
	"${phpcsfixer_cmd[@]}" fix --dry-run --config .php-cs-fixer.dist.php
else
	skip php-cs-fixer "php-cs-fixer"
fi

if [[ ${#phpunit_cmd[@]} -gt 0 ]]; then
	step "PHP tests (phpunit)"
	"${phpunit_cmd[@]}"
else
	skip phpunit "phpunit"
fi

if [[ ${#actionlint_cmd[@]} -gt 0 ]]; then
	step "Workflows (actionlint)"
	"${actionlint_cmd[@]}"
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
# both into the same misleading "not optimised" message. Discover every tracked
# SVG (git ls-files), like the shell-script lint above, so a newly added SVG is
# optimisation-checked too instead of silently skipped.
svgo_out="$(mktemp)"
trap 'rm -f "$svgo_out"' EXIT
svg_files=()
while IFS= read -r file; do
	svg_files+=("$file")
done < <(git ls-files '*.svg')
for f in "${svg_files[@]}"; do
	if ! npx svgo -i "$f" -o "$svgo_out" >/dev/null; then
		echo "  svgo failed to process $f"
		exit 1
	fi
	if ! diff -q "$svgo_out" "$f" >/dev/null; then
		echo "  $f is not optimised; run: npx svgo $f"
		exit 1
	fi
done

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

# Validate the built markup with the Nu Html Checker. Runs against dist/ so it
# checks exactly what ships — the entry page plus every prerendered spec landing
# page, and the SVG favicon — catching a markup or prerender-template bug before
# deploy. Guarded like the other non-npm CLIs: skipped with a notice when vnu is
# absent so validate.sh stays runnable everywhere; CI always enforces it. Two
# benign infos are filtered: the void-element trailing slash (Vite/Prettier house
# style) and the CSP meta check (a file:// false positive where script-src 'self'
# plus the inline-script hashes can't resolve without an origin; served over https
# the policy allows them, verified in-browser). The generated Tailwind CSS is not
# checked — vnu rejects modern properties it doesn't yet recognise.
if have vnu; then
	step "Built HTML + SVG (vnu)"
	html_files=()
	while IFS= read -r file; do
		html_files+=("$file")
	done < <(find dist -name '*.html')
	vnu --filterpattern '.*(Trailing slash on void elements|Content Security Policy).*' \
		--also-check-svg "${html_files[@]}" dist/favicon.svg
else
	skip vnu "built HTML/SVG validation"
fi

step "All CI checks passed."
