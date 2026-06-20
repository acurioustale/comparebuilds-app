/**
 * Tests for the allowlist HTML sanitiser applied to talent descriptions at
 * ingest time. The security invariant: anything not on the tiny allowlist must
 * come out as inert, escaped text — never as a live tag or attribute.
 */

import { describe, test } from 'vitest'
import assert from 'node:assert/strict'
import { sanitizeDescription } from './sanitizeDescription.js'

describe('non-string passthrough', () => {
  test('null is returned unchanged', () => assert.strictEqual(sanitizeDescription(null), null))
  test('undefined is returned unchanged', () =>
    assert.strictEqual(sanitizeDescription(undefined), undefined))
  test('number is returned unchanged', () => assert.strictEqual(sanitizeDescription(42), 42))
})

describe('allowed markup is preserved', () => {
  test('br variants are canonicalised', () => {
    assert.strictEqual(sanitizeDescription('a<br>b'), 'a<br />b')
    assert.strictEqual(sanitizeDescription('a<br/>b'), 'a<br />b')
    assert.strictEqual(sanitizeDescription('a<br />b'), 'a<br />b')
    assert.strictEqual(sanitizeDescription('a<BR>b'), 'a<br />b')
  })

  test('bold tags pass through', () => {
    assert.strictEqual(sanitizeDescription('<b>hi</b>'), '<b>hi</b>')
    assert.strictEqual(sanitizeDescription('<B>hi</B>'), '<b>hi</b>')
  })

  test('italic tags pass through', () => {
    assert.strictEqual(sanitizeDescription('<i>hi</i>'), '<i>hi</i>')
  })

  test('real game markup survives (style is canonicalised, trailing ; dropped)', () => {
    const real = 'Deal damage.<br /><b style="color:white;">Empowered:</b> deals more.'
    assert.strictEqual(
      sanitizeDescription(real),
      'Deal damage.<br /><b style="color:white">Empowered:</b> deals more.',
    )
  })

  test('color style is kept, value preserved', () => {
    assert.strictEqual(
      sanitizeDescription('<b style="color:#ffcc00;">x</b>'),
      '<b style="color:#ffcc00">x</b>',
    )
    assert.strictEqual(
      sanitizeDescription('<b style="color:rgb(255,0,0)">x</b>'),
      '<b style="color:rgb(255,0,0)">x</b>',
    )
  })

  test('font-weight style is kept', () => {
    assert.strictEqual(
      sanitizeDescription('<b style="font-weight:700;">x</b>'),
      '<b style="font-weight:700">x</b>',
    )
  })
})

describe('text is escaped', () => {
  test('ampersands and angle brackets in text become entities', () => {
    assert.strictEqual(sanitizeDescription('Fire & Frost'), 'Fire &amp; Frost')
    assert.strictEqual(sanitizeDescription('a < b > c'), 'a &lt; b &gt; c')
  })

  test('an unterminated angle bracket is escaped', () => {
    assert.strictEqual(sanitizeDescription('5 < 10 damage'), '5 &lt; 10 damage')
  })
})

describe('dangerous markup is neutralised', () => {
  test('script tags become inert text', () => {
    const out = sanitizeDescription('<script>alert(1)</script>')
    assert.ok(!/<script>/i.test(out), 'no live script tag')
    assert.strictEqual(out, '&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('img with onerror is neutralised', () => {
    const out = sanitizeDescription('<img src=x onerror="alert(1)">')
    assert.ok(!/<img/i.test(out), 'no live img tag')
    assert.ok(!/onerror=/i.test(out) || /&lt;img/i.test(out), 'onerror not live')
    assert.strictEqual(out, '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  })

  test('event-handler attribute on an allowed tag name is rejected', () => {
    // <b onmouseover=…> does not match the strict <b> / <b style="…"> shapes,
    // so the whole tag is escaped rather than stripped-but-kept.
    const out = sanitizeDescription('<b onmouseover="alert(1)">x</b>')
    assert.ok(!/onmouseover=[^&]/i.test(out), 'handler is not live')
    assert.ok(out.includes('&lt;b onmouseover'), 'opening tag escaped')
    assert.ok(out.endsWith('x</b>'), 'closing tag still allowed')
  })

  test('javascript: url inside a color style is dropped', () => {
    const out = sanitizeDescription('<b style="color:url(javascript:alert(1))">x</b>')
    assert.ok(!/javascript:/i.test(out), 'no javascript: survives')
    // The unsafe declaration is dropped, leaving a bare <b>.
    assert.strictEqual(out, '<b>x</b>')
  })

  test('disallowed style declarations are dropped', () => {
    const out = sanitizeDescription('<b style="color:red;background:url(x)">y</b>')
    assert.strictEqual(out, '<b style="color:red">y</b>')
  })

  test('unknown tags are escaped', () => {
    assert.strictEqual(sanitizeDescription('<iframe>x</iframe>'), '&lt;iframe&gt;x&lt;/iframe&gt;')
  })
})
