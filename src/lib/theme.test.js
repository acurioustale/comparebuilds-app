import { describe, test, expect } from 'vitest'
import {
  THEMES,
  THEME_STORAGE_KEY,
  THEME_COLORS,
  normalizeStoredTheme,
  resolveTheme,
  nextTheme,
} from './theme.js'

describe('normalizeStoredTheme', () => {
  test('honours the two explicit themes', () => {
    expect(normalizeStoredTheme('light')).toBe('light')
    expect(normalizeStoredTheme('dark')).toBe('dark')
  })

  test('treats anything else as no override', () => {
    for (const v of [null, undefined, '', 'Light', 'system', 'DARK', 'sepia', 0]) {
      expect(normalizeStoredTheme(v)).toBeNull()
    }
  })
})

describe('resolveTheme', () => {
  test('an explicit stored override wins over the OS preference', () => {
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', true)).toBe('dark')
  })

  test('with no override, follows the OS preference', () => {
    expect(resolveTheme(null, true)).toBe('light')
    expect(resolveTheme(null, false)).toBe('dark')
  })

  test('an unrecognised stored value falls back to the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('light')
    expect(resolveTheme('garbage', false)).toBe('dark')
  })
})

describe('nextTheme', () => {
  test('flips between the two themes', () => {
    expect(nextTheme('dark')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
  })
})

describe('constants', () => {
  test('expose both themes and a colour for each', () => {
    expect(THEMES).toEqual(['dark', 'light'])
    expect(typeof THEME_STORAGE_KEY).toBe('string')
    for (const t of THEMES) expect(THEME_COLORS[t]).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
