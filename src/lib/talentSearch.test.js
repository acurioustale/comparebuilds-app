import { describe, test } from 'vitest'
import assert from 'node:assert/strict'
import { matchNodeIds } from './talentSearch.js'

const NODES = [
  { id: 1, name: 'Death Strike', choices: null },
  { id: 2, name: 'Blood Boil', choices: null },
  { id: 3, name: null, choices: [{ name: 'Anti-Magic Barrier' }, { name: 'Death Pact' }] },
  { id: 4, name: 'Heart Strike', choices: null },
]

describe('matchNodeIds', () => {
  test('empty / whitespace query matches nothing', () => {
    assert.strictEqual(matchNodeIds('', NODES).size, 0)
    assert.strictEqual(matchNodeIds('   ', NODES).size, 0)
    assert.strictEqual(matchNodeIds(null, NODES).size, 0)
  })

  test('matches node names case-insensitively, substring', () => {
    assert.deepStrictEqual([...matchNodeIds('strike', NODES)].sort(), [1, 4])
    // 'death' matches Death Strike (node 1) and the Death Pact choice (node 3).
    assert.deepStrictEqual([...matchNodeIds('DEATH', NODES)].sort(), [1, 3])
  })

  test('matches any choice option name', () => {
    assert.deepStrictEqual([...matchNodeIds('pact', NODES)], [3])
    assert.deepStrictEqual([...matchNodeIds('anti-magic', NODES)], [3])
  })

  test('no match yields an empty set', () => {
    assert.strictEqual(matchNodeIds('nonexistent', NODES).size, 0)
  })

  test('tolerates a missing/!array node list', () => {
    assert.strictEqual(matchNodeIds('x', null).size, 0)
  })
})
