// ─── Prerender spec landing pages ─────────────────────────────────────────────
//
// Runs after `vite build`. For every implemented class+spec it writes
// dist/<class>/<spec>/index.html — a copy of the built index.html with
// spec-specific <title>/description/canonical/OG tags and a static <main> summary
// inside #root (crawlers see it; React replaces it on mount). Also emits
// sitemap.xml and robots.txt. Hash routing still serves the live app at "/"; these
// are real URLs purely so search engines and link previews have something to read.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const ORIGIN = "https://comparebuilds.app";

// W3C date (YYYY-MM-DD) of the last commit that touched the given repo-relative
// paths, or null when git history isn't available (a shallow CI clone, a source
// tarball, or no git at all). A page's content only changes when its source data
// changes, so this tracks real content age rather than build time — and a null
// just omits <lastmod> rather than emitting a misleading one a crawler would
// learn to distrust. The deploy job checks out full history (fetch-depth: 0); the
// validate build runs shallow and simply produces a lastmod-less sitemap it never
// ships.
function lastModified(...relPaths) {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%cs", "--", ...relPaths],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

// Read the class index via fs (rather than an import attribute) so the build
// script parses under the same lint config as the rest of the repo.
const classes = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src/data/classes.json"), "utf8"),
);

const seg = (slug) => slug.replaceAll("_", "-");
const escAttr = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
const escHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Entity-escape a value bound for XML text (the sitemap <loc>). Slugs are ASCII
// path segments today, but seg() only swaps underscores for hyphens — it does
// not sanitise — so escape at the emission point rather than trusting the slug
// to stay XML-safe. A future slug carrying '&' or '<' would otherwise emit a
// malformed sitemap. Escapes the five characters named by the sitemaps.org
// protocol; only '&' and '<' are strictly required in element content, but the
// full set matches the spec and stays correct if the value ever moves to an
// attribute.
const escXml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

// Replace exactly one match of `re`, throwing if the pattern isn't found. The
// template's <title>/<link>/<meta> tags are matched by attribute-order-sensitive
// regexes, so a silent no-op (a reordered attribute, a renamed tag, a Vite/plugin
// change) would otherwise ship the homepage's default title/description on every
// prerendered spec page with no error. Failing loudly makes that a build failure.
function replaceOnce(html, re, replacement, label) {
  if (!re.test(html)) {
    throw new Error(
      `prerenderSpecs: no match for ${label} in the HTML template`,
    );
  }
  return html.replace(re, replacement);
}

/** Replaces the content="" of the <meta> identified by attr/key (single- or multi-line). */
function setMeta(html, attr, key, value) {
  const re = new RegExp(
    `(<meta\\b[^>]*?\\b${attr}="${key}"[^>]*?\\bcontent=")[^"]*(")`,
    "",
  );
  return replaceOnce(
    html,
    re,
    `$1${escAttr(value)}$2`,
    `<meta ${attr}="${key}">`,
  );
}

function buildPage(template, { title, description, url, summary }) {
  let html = template;
  html = replaceOnce(
    html,
    /<title>[\s\S]*?<\/title>/,
    `<title>${escHtml(title)}</title>`,
    "<title>",
  );
  // Point the template's canonical (homepage URL) at this spec's URL.
  html = replaceOnce(
    html,
    /(<link\b[^>]*\brel="canonical"[^>]*\bhref=")[^"]*(")/,
    `$1${escAttr(url)}$2`,
    'rel="canonical"',
  );
  html = setMeta(html, "name", "description", description);
  html = setMeta(html, "property", "og:title", title);
  html = setMeta(html, "property", "og:description", description);
  html = setMeta(html, "property", "og:url", url);
  html = setMeta(html, "name", "twitter:title", title);
  html = setMeta(html, "name", "twitter:description", description);
  // Static SEO content inside #root; React replaces it on mount for JS visitors.
  // The template ships an empty <main></main> placeholder inside #root; swap that
  // placeholder for the summary (itself a <main>). Match the <main> rather than
  // the #root </div>: keying off </div> with a non-greedy match stops at the
  // FIRST </div>, so any future nested <div> inside #root (valid HTML) would
  // truncate the page — whereas a nested <main> is invalid HTML the Nu checker
  // already rejects. Via replaceOnce so a template that drops the placeholder
  // fails the build instead of silently shipping a summary-less page.
  html = replaceOnce(
    html,
    /(<div\b[^>]*\bid="root"[^>]*>\s*)<main\b[^>]*>[\s\S]*?<\/main>/,
    (_match, openPart) => `${openPart}${summary}`,
    '<div id="root"> <main> placeholder',
  );
  return html;
}

function summaryHtml(cls, spec) {
  const others = cls.specs
    .filter((s) => s.id !== spec.id)
    .map(
      (s) =>
        `<a href="/${seg(cls.name)}/${seg(s.name)}/">${escHtml(s.displayName)}</a>`,
    )
    .join(" · ");
  return [
    '<main style="max-width:680px;margin:0 auto;padding:2rem 1rem;font-family:system-ui,sans-serif;color:#c8a84b">',
    `<h1>${escHtml(spec.displayName)} ${escHtml(cls.displayName)} Talent Build Calculator</h1>`,
    spec.description ? `<p>${escHtml(spec.description)}</p>` : "",
    `<p>Build, import and compare ${escHtml(spec.displayName)} ${escHtml(cls.displayName)} talent loadouts side by side on Compare Builds.</p>`,
    others ? `<p>Other ${escHtml(cls.displayName)} specs: ${others}</p>` : "",
    '<p><a href="/">All classes and specs →</a></p>',
    "</main>",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Run ──────────────────────────────────────────────────────────────────────
const templatePath = path.join(DIST, "index.html");
if (!fs.existsSync(templatePath)) {
  console.error(
    "prerenderSpecs: dist/index.html not found — run `vite build` first.",
  );
  process.exit(1);
}
const template = fs.readFileSync(templatePath, "utf8");

// The home page lists every class/spec, so it's as fresh as the newest data file.
const urls = [{ loc: `${ORIGIN}/`, lastmod: lastModified("src/data") }];
let count = 0;
for (const cls of classes) {
  if (!cls.implemented) continue;
  // A spec page's content is derived entirely from its class data file, so that
  // file's last change is the page's true last-modified date.
  const lastmod = lastModified(`src/data/${cls.name}.json`);
  for (const spec of cls.specs) {
    const url = `${ORIGIN}/${seg(cls.name)}/${seg(spec.name)}/`;
    const title = `${spec.displayName} ${cls.displayName} Talent Build Calculator — Compare Builds`;
    const description = `Build, import and compare ${spec.displayName} ${cls.displayName} talent loadouts side by side, then share them with a short link.`;
    const page = buildPage(template, {
      title,
      description,
      url,
      summary: summaryHtml(cls, spec),
    });

    const dir = path.join(DIST, seg(cls.name), seg(spec.name));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), page);
    urls.push({ loc: url, lastmod });
    count++;
  }
}

// Sitemap + robots. Emit <lastmod> only when we have a real commit date.
const sitemap =
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls
    .map(({ loc, lastmod }) =>
      lastmod
        ? `  <url><loc>${escXml(loc)}</loc><lastmod>${lastmod}</lastmod></url>`
        : `  <url><loc>${escXml(loc)}</loc></url>`,
    )
    .join("\n") +
  "\n</urlset>\n";
fs.writeFileSync(path.join(DIST, "sitemap.xml"), sitemap);
fs.writeFileSync(
  path.join(DIST, "robots.txt"),
  `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`,
);

console.log(
  `prerenderSpecs: wrote ${count} spec pages + sitemap.xml + robots.txt`,
);
