import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

// Flat config. Static analysis is intentionally lightweight: the recommended JS
// rules, the React Hooks rules (rules-of-hooks as an error, exhaustive-deps as a
// warning so the existing intentional disables remain explicit), and the
// react-refresh HMR guard. CI runs `npm run lint` alongside the tests.
export default [
  { ignores: ['dist/**', 'coverage/**'] },

  js.configs.recommended,

  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.serviceworker },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Node-context tooling.
  {
    files: ['vite.config.js', 'eslint.config.js', 'scripts/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Test suites: Node environment plus Vitest globals (vite.config sets globals: true).
  {
    files: ['**/*.test.{js,jsx}', 'src/test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        describe: 'readonly', test: 'readonly', it: 'readonly', expect: 'readonly',
        vi: 'readonly', beforeEach: 'readonly', afterEach: 'readonly',
        beforeAll: 'readonly', afterAll: 'readonly',
      },
    },
  },
]
