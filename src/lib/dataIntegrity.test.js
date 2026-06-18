/**
 * Data-integrity tests.
 *
 * Run:  npm test   (or: npx vitest run src/lib/dataIntegrity.test.js)
 *
 * Two layers of protection for the normalised data in src/data/:
 *
 *   1. Schema validation — every implemented class validates against
 *      validateClassData(), cross-checked against the classes.json index.
 *      Catches malformed hand edits and structurally different sources.
 *
 *   2. Wire-layout snapshot — the build-string bit layout per class is
 *      fingerprinted and compared to a committed snapshot. Catches data changes
 *      that would silently shift bit positions and break existing build strings.
 *      Regenerate intentionally with:  UPDATE_SNAPSHOTS=1 npm test
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { validateClassData } from './validateClassData.js'
import { wireLayout } from './wireLayout.js'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_PATH = join(__dirname, 'wireLayout.snapshot.json')
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1'

const classIndex = require('../data/classes.json')
const implemented = classIndex.filter((c) => c.implemented)

// ── 1. Schema validation ──────────────────────────────────────────────────────


for (const cls of implemented) {
  test(`${cls.displayName} validates against the schema + index`, () => {
    const data = require(`../data/${cls.name}.json`)
    const errors = validateClassData(data, cls)
    assert.strictEqual(errors.length, 0,
      `${errors.length} problem(s):\n` + errors.map((e) => `         - ${e}`).join('\n'))
  })
}

test('every implemented class in the index has a data file', () => {
  for (const cls of implemented) {
    assert.ok(existsSync(join(__dirname, '..', 'data', `${cls.name}.json`)),
      `missing src/data/${cls.name}.json`)
  }
})

// ── 2. Wire-layout snapshot ───────────────────────────────────────────────────


const current = {}
for (const cls of implemented) {
  current[cls.name] = wireLayout(require(`../data/${cls.name}.json`))
}

if (UPDATE || !existsSync(SNAPSHOT_PATH)) {
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8')
  console.log(`  ⟳  ${UPDATE ? 'updated' : 'created'} ${SNAPSHOT_PATH.replace(/.*\/src\//, 'src/')}`)
} else {
  const saved = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))

  for (const cls of implemented) {
    test(`${cls.displayName} wire layout is unchanged`, () => {
      const exp = saved[cls.name]
      const got = current[cls.name]
      assert.ok(exp, `no snapshot for "${cls.name}" — run UPDATE_SNAPSHOTS=1 if this class is new`)
      assert.deepStrictEqual(got, exp,
        `wire layout changed (count ${exp.count}→${got.count}). ` +
        `If this was an intentional data update, regenerate with ` +
        `UPDATE_SNAPSHOTS=1 npm test — but note every existing build string for ` +
        `${cls.displayName} will now parse differently.`)
    })
  }

  test('snapshot has no stale classes', () => {
    for (const name of Object.keys(saved)) {
      assert.ok(current[name], `snapshot has "${name}" but no implemented class matches`)
    }
  })
}
