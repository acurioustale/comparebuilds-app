import { describe, it, expect } from "vitest";

import { buildPage, summaryHtml } from "./prerenderSpecs.js";

// A minimal stand-in for the built index.html: just the tags buildPage rewrites.
const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <title>Compare Builds</title>
    <link rel="canonical" href="https://comparebuilds.app/" />
    <meta name="description" content="default" />
    <meta property="og:title" content="default" />
    <meta property="og:description" content="default" />
    <meta property="og:url" content="https://comparebuilds.app/" />
    <meta name="twitter:title" content="default" />
    <meta name="twitter:description" content="default" />
  </head>
  <body>
    <div id="root"><main></main></div>
  </body>
</html>`;

const page = (title, description = "A description.") =>
  buildPage(TEMPLATE, {
    title,
    description,
    url: "https://comparebuilds.app/priest/shadow/",
    summary: "<main>summary</main>",
  });

describe("buildPage", () => {
  it("writes the title, canonical and metas for the spec", () => {
    const html = page("Shadow Priest Talent Build Calculator");
    expect(html).toContain(
      "<title>Shadow Priest Talent Build Calculator</title>",
    );
    expect(html).toContain(
      '<link rel="canonical" href="https://comparebuilds.app/priest/shadow/" />',
    );
    expect(html).toContain(
      '<meta property="og:title" content="Shadow Priest Talent Build Calculator" />',
    );
    expect(html).toContain('<div id="root"><main>summary</main></div>');
  });

  // escAttr/escHtml escape &, <, > and " — not "$". A "$&", "$`", "$'" or "$1"
  // reaching String.replace as a replacement *string* expands to the matched
  // text, which for these patterns is a whole tag: the <head> of all 40 pages
  // would then carry nested markup. The replacements take the function form so
  // the value is inserted verbatim.
  it("inserts a dollar sequence literally rather than expanding it", () => {
    // [as written, as it must appear in the output]. Only the "&" of "$&" is
    // touched, by the ordinary entity escaping; the "$" itself survives.
    const tokens = [
      ["$&", "$&amp;"],
      ["$1", "$1"],
      ["$`", "$`"],
      ["$'", "$'"],
      ["$$", "$$"],
    ];
    for (const [token, escaped] of tokens) {
      const html = page(`Rogue ${token} Build`, `Compare ${token} loadouts.`);
      expect(html).toContain(`<title>Rogue ${escaped} Build</title>`);
      expect(html).toContain(
        `<meta property="og:title" content="Rogue ${escaped} Build" />`,
      );
      expect(html).toContain(
        `<meta name="description" content="Compare ${escaped} loadouts." />`,
      );
      // The tell-tale of an expansion: the matched tag re-emitted inside itself.
      expect(html).not.toContain("<title><title>");
      expect(html).not.toContain('content="<meta');
    }
  });

  it("escapes markup in a display name", () => {
    const html = page('Fury <b>"Warrior"</b> & Co');
    expect(html).toContain(
      '<title>Fury &lt;b&gt;"Warrior"&lt;/b&gt; &amp; Co</title>',
    );
    // escAttr escapes the quote, which escHtml does not, and leaves ">" alone,
    // which is harmless inside an attribute value.
    expect(html).toContain(
      '<meta property="og:title" content="Fury &lt;b>&quot;Warrior&quot;&lt;/b> &amp; Co" />',
    );
  });
});

describe("summaryHtml", () => {
  it("escapes a dollar sequence and markup in the display names", () => {
    const cls = {
      name: "demon_hunter",
      displayName: "Demon $& Hunter",
      specs: [
        { id: 1, name: "havoc", displayName: "Havoc $1", description: "$&" },
        { id: 2, name: "vengeance", displayName: "Vengeance <x>" },
      ],
    };
    const html = summaryHtml(cls, cls.specs[0]);
    expect(html).toContain("<h1>Havoc $1 Demon $&amp; Hunter");
    expect(html).toContain("<p>$&amp;</p>");
    expect(html).toContain(
      '<a href="/demon-hunter/vengeance/">Vengeance &lt;x&gt;</a>',
    );
  });
});
