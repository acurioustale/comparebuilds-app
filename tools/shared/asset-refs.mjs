// Shared reference scanner: every local file a page's markup, its stylesheets
// and a web app manifest point at. A guard built on this asserts each one
// exists; the rules for *finding* a reference live here, with a test of their
// own, rather than as a private regex inside the guard.
//
// Three rules have to be right, and each is easy to get subtly wrong on real
// input: which attributes carry a reference (an <img srcset> holds several,
// comma-separated, each with a descriptor), what counts as local (a same-origin
// absolute URL such as the og:image/twitter:image share image is local, an
// off-site one is not), and what a reference resolves against (a url() inside a
// stylesheet is relative to that stylesheet's directory, not to the web root).
//
// The `label` on htmlRefs/manifestRefs is what the reported location is prefixed
// with. It is a parameter rather than a constant because the caller knows which
// document it handed over — one repo scans a single source index.html, another
// scans a built entry page plus a directory of prerendered ones — and an error
// naming the wrong page is worse than no prefix at all. The defaults are the
// conventional names for the two documents, for a caller that only has one of
// each.
//
// Dependency-free on purpose: the shared HTML scanner plus small scans over
// well-formed markup and CSS, not a general parser.
import { findTags } from "./html-tags.mjs";

// The origins that are "us": the site's own, taken from the markup so nothing
// hardcodes the hostname. <link rel="canonical"> and og:url both carry it; a
// reference on any other origin is somebody else's file and not ours to check.
export function declaredOrigins(html) {
  const origins = new Set();
  const add = (value) => {
    if (!value) return;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // Not an absolute URL (a relative canonical, say): it names no origin.
    }
  };
  for (const link of findTags(html, "link", { rel: "canonical" }))
    add(link.attrs.get("href"));
  for (const meta of findTags(html, "meta", { property: "og:url" }))
    add(meta.attrs.get("content"));
  return origins;
}

// The web-root-relative path a reference points at, or undefined when it is not
// a local file. A scheme or protocol-relative URL is local only when its origin
// is one of ours (so the absolute share-image URL is checked, while an off-site
// image is skipped); a fragment is in-page; a bare root or a directory path
// resolves to a listing, not a file. A root-relative "/" path is taken from the
// web root, anything else from `base` — the directory the referencing file sits
// in, so a url() inside a stylesheet resolves beside that stylesheet. Percent
// escapes are decoded, since a filesystem and git both hold the decoded name.
export function localPath(ref, { origins = new Set(), base = "" } = {}) {
  if (!ref) return undefined;
  let value = ref.trim();
  if (value === "" || value.startsWith("#")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) {
    let url;
    try {
      url = new URL(value, "https://example.invalid/");
    } catch {
      return undefined; // Unparseable: nothing we can bind to a file.
    }
    if (!origins.has(url.origin)) return undefined;
    value = url.pathname;
  }
  const [raw] = value.split(/[?#]/);
  const path = raw.startsWith("/")
    ? raw.slice(1)
    : `${base}${raw.replace(/^(?:\.\/)+/, "")}`;
  const normalised = decode(path).replace(/^\/+/, "");
  if (normalised === "" || normalised.endsWith("/")) return undefined;
  return normalised;
}

// A percent-decoded path, or the path verbatim when it carries an escape that is
// not valid UTF-8 (decodeURIComponent throws on those) — the reference is then
// broken anyway, and reporting it as written beats crashing the guard.
function decode(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

// The directory part of a relative file path, with its trailing slash
// ("css/style.css" → "css/", "index.html" → "").
export function dirOf(path) {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut + 1);
}

// The URLs in a srcset value, per the HTML syntax: candidates separated by
// commas, each a URL optionally followed by a width or density descriptor. A URL
// runs to the next whitespace — commas included, so "a.png,b.png" is one URL,
// exactly as a browser reads it — with trailing commas trimmed when no
// descriptor follows; otherwise the descriptor is skipped up to the next comma.
// Splitting on "," alone would instead take "a.png 2x" as a URL.
export function parseSrcset(value) {
  const urls = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i += 1;
    const start = i;
    while (i < value.length && !/\s/.test(value[i])) i += 1;
    const candidate = value.slice(start, i);
    if (candidate.endsWith(",")) {
      const url = candidate.replace(/,+$/, "");
      if (url) urls.push(url);
    } else {
      if (candidate) urls.push(candidate);
      while (i < value.length && value[i] !== ",") i += 1; // skip the descriptor
    }
  }
  return urls;
}

// The url() targets in a stylesheet, quotes unwrapped, comments stripped first
// so a commented-out rule contributes nothing. A url() token may be unquoted, in
// which case it runs to the closing paren.
export function cssUrls(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const urls = [];
  const URL_TOKEN = /url\(\s*("[^"]*"|'[^']*'|[^)]*?)\s*\)/gi;
  for (const [, raw] of withoutComments.matchAll(URL_TOKEN)) {
    const q = raw[0];
    const quoted =
      (q === '"' || q === "'") && raw.length >= 2 && raw.at(-1) === q;
    urls.push(quoted ? raw.slice(1, -1) : raw);
  }
  return urls;
}

// The attributes that carry a local reference, per element. `srcset` holds a
// list, the rest a single URL. A <meta> is handled separately: its reference
// lives in `content`, and only for the image properties below. An <a href> is
// deliberately absent: it names a route, not a file to ship.
const URL_ATTRS = [
  { tag: "link", single: ["href"], list: ["imagesrcset"] },
  { tag: "script", single: ["src"] },
  { tag: "img", single: ["src"], list: ["srcset"] },
  { tag: "source", single: ["src"], list: ["srcset"] },
  { tag: "video", single: ["src", "poster"] },
  { tag: "audio", single: ["src"] },
];

// The metas whose content is an image URL. The share image is the one reference
// that is written as an absolute URL (the OG spec requires it), which is exactly
// why an unchecked one could point at a renamed file and still pass.
const IMAGE_METAS = [
  ["property", "og:image"],
  ["property", "og:image:url"],
  ["property", "og:image:secure_url"],
  ["name", "twitter:image"],
];

// Every local reference in `html`, as { path, where }.
export function htmlRefs(
  html,
  origins = declaredOrigins(html),
  label = "index.html",
) {
  const refs = [];
  const push = (path, where) => {
    if (path) refs.push({ path, where });
  };
  for (const { tag, single = [], list = [] } of URL_ATTRS) {
    for (const el of findTags(html, tag)) {
      for (const attr of single) {
        const value = el.attrs.get(attr);
        push(
          localPath(value, { origins }),
          `${label} <${tag} ${attr}="${value}">`,
        );
      }
      for (const attr of list) {
        for (const url of parseSrcset(el.attrs.get(attr) ?? "")) {
          push(
            localPath(url, { origins }),
            `${label} <${tag} ${attr}> "${url}"`,
          );
        }
      }
    }
  }
  for (const [attr, value] of IMAGE_METAS) {
    for (const meta of findTags(html, "meta", { [attr]: value })) {
      const content = meta.attrs.get("content");
      push(
        localPath(content, { origins }),
        `${label} <meta ${attr}="${value}" content="${content}">`,
      );
    }
  }
  return refs;
}

// Every local reference in a stylesheet, resolved against its own directory.
export function cssRefs(css, path, origins = new Set()) {
  const base = dirOf(path);
  const refs = [];
  for (const url of cssUrls(css)) {
    const local = localPath(url, { origins, base });
    if (local) refs.push({ path: local, where: `${path} url(${url})` });
  }
  return refs;
}

// Every local reference in a web app manifest: the icon and screenshot lists.
export function manifestRefs(
  manifestText,
  origins = new Set(),
  label = "manifest.webmanifest",
) {
  const manifest = JSON.parse(manifestText);
  const refs = [];
  for (const field of ["icons", "screenshots"]) {
    for (const entry of manifest[field] ?? []) {
      const path = localPath(entry?.src, { origins });
      if (path)
        refs.push({ path, where: `${label} ${field} src="${entry.src}"` });
    }
  }
  return refs;
}
