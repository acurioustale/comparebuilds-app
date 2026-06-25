import { describe, test } from 'vitest'
import assert from 'node:assert/strict'
import { encodeBuildsHash, decodeBuildsHash } from './shareLink.js'

describe('shareLink encode/decode', () => {
  test('round-trips a single build', () => {
    const builds = ['CoPAAAAAAAAAAAAAAAAAAAAAAAYGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']
    const out = decodeBuildsHash(encodeBuildsHash({ builds }))
    assert.deepStrictEqual(out.builds, builds)
    assert.deepStrictEqual(out.names, [''])
  })

  test('round-trips multiple builds', () => {
    const builds = ['CoPAAAA', 'CoPBBBB', 'CoPCCCC']
    const out = decodeBuildsHash(encodeBuildsHash({ builds }))
    assert.deepStrictEqual(out.builds, builds)
  })

  test('round-trips names, including Unicode', () => {
    const builds = ['CoPAAAA', 'CoPBBBB']
    const names = ['Raid ST', 'Mythic+ åäö ♥']
    const out = decodeBuildsHash(encodeBuildsHash({ builds, names }))
    assert.deepStrictEqual(out.builds, builds)
    assert.deepStrictEqual(out.names, names)
  })

  test('omits the names section when all names are empty', () => {
    const builds = ['CoPAAAA']
    // No `n` key → shorter token; decode still yields parallel empty names.
    const token = encodeBuildsHash({ builds, names: ['', ''] })
    const out = decodeBuildsHash(token)
    assert.deepStrictEqual(out.names, [''])
  })

  test('pads names to build length when only some are set', () => {
    const builds = ['CoPAAAA', 'CoPBBBB']
    const out = decodeBuildsHash(encodeBuildsHash({ builds, names: ['only first'] }))
    assert.deepStrictEqual(out.names, ['only first', ''])
  })

  test('produces a URL-safe token (base64url alphabet only)', () => {
    const token = encodeBuildsHash({ builds: ['CoP+/AAA=='], names: ['x'] })
    assert.match(token, /^[A-Za-z0-9_-]+$/)
  })

  test('returns null for malformed input', () => {
    assert.strictEqual(decodeBuildsHash(''), null)
    assert.strictEqual(decodeBuildsHash('not%%%base64'), null)
    assert.strictEqual(decodeBuildsHash(undefined), null)
    // Valid base64url but not the expected shape.
    assert.strictEqual(decodeBuildsHash(encodeBuildsHashRaw('{"x":1}')), null)
    assert.strictEqual(decodeBuildsHash(encodeBuildsHashRaw('{"b":[]}')), null)
  })
})

// Helper to craft an arbitrary JSON payload as a token, for the malformed cases.
function encodeBuildsHashRaw(json) {
  const bytes = new TextEncoder().encode(json)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
