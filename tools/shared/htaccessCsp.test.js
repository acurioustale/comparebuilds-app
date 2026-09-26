import { test } from "node:test";
import assert from "node:assert/strict";

import { readHeaderCsp } from "./htaccess-csp.mjs";

test("readHeaderCsp reads a top-level Header set directive", () => {
  const { headerCsp, scopesUnbalanced } = readHeaderCsp(
    `Header always set Content-Security-Policy "default-src 'none'; script-src 'self'"`,
  );
  assert.equal(headerCsp, "default-src 'none'; script-src 'self'");
  assert.equal(scopesUnbalanced, false);
});

test("readHeaderCsp reassembles a backslash-continued directive", () => {
  // Apache joins a line ending in `\` onto the next; a maintainer may wrap the
  // long CSP for readability. The value must read as one logical line, not go
  // undetected because its first line never closes the quote.
  const { headerCsp } = readHeaderCsp(
    "Header always set Content-Security-Policy \"default-src 'none'; \\\n" +
      "  script-src 'self'; style-src 'self'\"",
  );
  assert.equal(
    headerCsp,
    "default-src 'none';   script-src 'self'; style-src 'self'",
  );
});

test("readHeaderCsp reassembles a continuation with CRLF line endings", () => {
  const { headerCsp } = readHeaderCsp(
    "Header set Content-Security-Policy \"default-src 'none'; \\\r\n" +
      "script-src 'self'\"\r\n",
  );
  assert.equal(headerCsp, "default-src 'none'; script-src 'self'");
});

test("readHeaderCsp skips comment lines and takes the last live directive", () => {
  const { headerCsp } = readHeaderCsp(
    [
      `# Header set Content-Security-Policy "commented-out"`,
      `Header set Content-Security-Policy "first"`,
      `Header set Content-Security-Policy "second"`,
    ].join("\n"),
  );
  assert.equal(headerCsp, "second");
});

test("readHeaderCsp treats <IfModule> as transparent, not a request scope", () => {
  const { headerCsp, scopesUnbalanced } = readHeaderCsp(
    [
      `<IfModule mod_headers.c>`,
      `  Header set Content-Security-Policy "live"`,
      `</IfModule>`,
    ].join("\n"),
  );
  assert.equal(headerCsp, "live");
  assert.equal(scopesUnbalanced, false);
});

test("readHeaderCsp does not read a CSP inside a request-scoping container as global", () => {
  const { headerCsp, scopedHeaders } = readHeaderCsp(
    [
      `Header set Content-Security-Policy "global"`,
      `<Files "admin">`,
      `  Header set Content-Security-Policy "scoped"`,
      `</Files>`,
    ].join("\n"),
  );
  assert.equal(headerCsp, "global");
  // Not read as the global policy, but still reported: it is served for every
  // request the container matches.
  assert.deepEqual(scopedHeaders, [
    `Header set Content-Security-Policy "scoped"`,
  ]);
});

test("readHeaderCsp does not read a CSP inside a method-scoped <Limit> container as global", () => {
  // A CSP inside <Limit GET> is served only for GET; it must not be read as the
  // global policy, or a weaker method-scoped CSP would validate as unconditional.
  const { headerCsp, scopedHeaders } = readHeaderCsp(
    [
      `Header set Content-Security-Policy "global"`,
      `<Limit GET POST>`,
      `  Header set Content-Security-Policy "scoped"`,
      `</Limit>`,
    ].join("\n"),
  );
  assert.equal(headerCsp, "global");
  assert.deepEqual(scopedHeaders, [
    `Header set Content-Security-Policy "scoped"`,
  ]);
});

test("readHeaderCsp reports every CSP-touching form inside a scope", () => {
  // A scoped unset, append or conditional set weakens what matching requests are
  // served just as a scoped set does, so each is reported, nested scopes too.
  const lines = [
    `Header unset Content-Security-Policy`,
    `Header append Content-Security-Policy "script-src 'unsafe-inline'"`,
    `Header set Content-Security-Policy "x" env=foo`,
    `Header always set Content-Security-Policy "default-src *"`,
  ];
  const { headerCsp, unsupportedHeaders, scopedHeaders } = readHeaderCsp(
    [
      `<IfModule mod_headers.c>`,
      `  Header always set Content-Security-Policy "global"`,
      `  <FilesMatch "\\.html$">`,
      `    ${lines[0]}`,
      `    <If "%{QUERY_STRING} =~ /x/">`,
      `      ${lines[1]}`,
      `    </If>`,
      `  </FilesMatch>`,
      `  <Files "index.html">`,
      `    ${lines[2]}`,
      `    ${lines[3]}`,
      `  </Files>`,
      `</IfModule>`,
    ].join("\n"),
  );
  assert.equal(headerCsp, "global");
  // Scoped lines are reported as scoped, not also as unsupported top-level forms.
  assert.deepEqual(unsupportedHeaders, []);
  assert.deepEqual(scopedHeaders, lines);
});

test("readHeaderCsp leaves a scoped non-CSP header and Report-Only header unreported", () => {
  const { scopedHeaders } = readHeaderCsp(
    [
      `Header set Content-Security-Policy "global"`,
      `<FilesMatch "\\.(png|svg)$">`,
      `  Header set Cache-Control "max-age=31536000, immutable"`,
      `  Header set Content-Security-Policy-Report-Only "default-src 'none'"`,
      `</FilesMatch>`,
    ].join("\n"),
  );
  assert.deepEqual(scopedHeaders, []);
});

test("readHeaderCsp flags a stray close as unbalanced", () => {
  const { scopesUnbalanced } = readHeaderCsp(
    [`</Files>`, `Header set Content-Security-Policy "x"`].join("\n"),
  );
  assert.equal(scopesUnbalanced, true);
});

test("readHeaderCsp flags an unclosed container as unbalanced", () => {
  const { scopesUnbalanced } = readHeaderCsp(
    [`<Directory "/">`, `Header set Content-Security-Policy "x"`].join("\n"),
  );
  assert.equal(scopesUnbalanced, true);
});

test("readHeaderCsp returns undefined when no directive is present", () => {
  const { headerCsp, scopesUnbalanced, unsupportedHeaders, scopedHeaders } =
    readHeaderCsp(`# nothing here`);
  assert.equal(headerCsp, undefined);
  assert.equal(scopesUnbalanced, false);
  assert.deepEqual(unsupportedHeaders, []);
  assert.deepEqual(scopedHeaders, []);
});

test("readHeaderCsp flags a Header append that combines with the served CSP", () => {
  // `append` combines a value onto the existing header — the browser is served
  // more than the `set` value, so validating the set alone would miss it.
  const { headerCsp, unsupportedHeaders } = readHeaderCsp(
    [
      `Header set Content-Security-Policy "default-src 'none'"`,
      `Header append Content-Security-Policy "script-src 'unsafe-inline'"`,
    ].join("\n"),
  );
  assert.equal(headerCsp, "default-src 'none'");
  assert.deepEqual(unsupportedHeaders, [
    `Header append Content-Security-Policy "script-src 'unsafe-inline'"`,
  ]);
});

test("readHeaderCsp flags a conditional set that is served only sometimes", () => {
  // A trailing `env=`/`expr=` makes the header conditional; the guard would
  // otherwise capture the value and validate it as unconditional.
  const { unsupportedHeaders } = readHeaderCsp(
    `Header set Content-Security-Policy "default-src 'none'" "expr=%{HTTP_HOST} == 'x'"`,
  );
  assert.deepEqual(unsupportedHeaders, [
    `Header set Content-Security-Policy "default-src 'none'" "expr=%{HTTP_HOST} == 'x'"`,
  ]);
});

test("readHeaderCsp does not flag the plain unconditional set form", () => {
  const { headerCsp, unsupportedHeaders } = readHeaderCsp(
    `Header always set Content-Security-Policy "default-src 'none'"`,
  );
  assert.equal(headerCsp, "default-src 'none'");
  assert.deepEqual(unsupportedHeaders, []);
});

test("readHeaderCsp ignores a Content-Security-Policy-Report-Only header", () => {
  // A separate, additive header: it enforces nothing, so it neither weakens the
  // policy this guard validates nor makes it unreadable.
  const { headerCsp, unsupportedHeaders } = readHeaderCsp(
    [
      `Header always set Content-Security-Policy "default-src 'none'"`,
      `Header always set Content-Security-Policy-Report-Only "default-src 'self'; report-uri /csp"`,
    ].join("\n"),
  );
  assert.equal(headerCsp, "default-src 'none'");
  assert.deepEqual(unsupportedHeaders, []);
});
