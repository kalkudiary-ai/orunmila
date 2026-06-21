'use strict';

/**
 * ESLint flat config (v9+). orunmila is plain CommonJS for Node >= 18 with zero
 * runtime dependencies, so this is intentionally lean: the recommended ruleset,
 * Node/CommonJS globals, and a few project-specific allowances.
 *
 * The codebase deliberately uses empty `catch {}` blocks in the capture layer
 * (a capture error must never surface to the agent — see src/capture/core.js),
 * so `no-empty` permits empty catch blocks rather than forcing a no-op comment
 * on every defensive arm.
 */

const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    ignores: ['coverage/**', 'node_modules/**', '**/*.html'],
  },
];
