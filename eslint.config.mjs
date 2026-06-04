/**
 * ESLint 9 (flat config) — scripts de extensión Chrome (MV3).
 * No afecta el funcionamiento de la extensión; solo ayuda en desarrollo.
 */
import js from '@eslint/js';
import globals from 'globals';

const chromeApi = { chrome: 'readonly' };

export default [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    files: ['background.js', 'panelManager.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.serviceworker,
        ...chromeApi,
        importScripts: 'readonly',
      },
    },
  },
  {
    files: ['**/*.js'],
    ignores: ['background.js', 'panelManager.js', 'tests/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...chromeApi,
      },
    },
  },
  {
    files: ['scripts/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...chromeApi,
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        vi: 'readonly',
      },
    },
  },
  {
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-prototype-builtins': 'off',
    },
  },
];
