import { describe, test } from 'vitest'
import assert from 'node:assert/strict'
import { resolveRoute } from './route.js'

describe('resolveRoute', () => {
  test('a 6-char alphanumeric hash is a server short-link', () => {
    assert.deepStrictEqual(resolveRoute({ hash: '#aB3xZ9' }), { kind: 'server-share', id: 'aB3xZ9' })
  })

  test('a #b= hash is a client-side instant link', () => {
    assert.deepStrictEqual(resolveRoute({ hash: '#b=SOMETOKEN' }), { kind: 'client-share', token: 'SOMETOKEN' })
  })

  test('an empty client token still resolves as client-share (decode rejects it later)', () => {
    assert.deepStrictEqual(resolveRoute({ hash: '#b=' }), { kind: 'client-share', token: '' })
  })

  test('no hash is a local restore', () => {
    assert.deepStrictEqual(resolveRoute({ hash: '' }), { kind: 'local' })
  })

  test('an unrecognised hash falls back to local', () => {
    assert.deepStrictEqual(resolveRoute({ hash: '#something-else' }), { kind: 'local' })
    // A 5- or 7-char hash is not a valid share id.
    assert.deepStrictEqual(resolveRoute({ hash: '#abcde' }), { kind: 'local' })
    assert.deepStrictEqual(resolveRoute({ hash: '#abcdefg' }), { kind: 'local' })
  })
})
