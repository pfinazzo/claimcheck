/**
 * Why this file exists: the coding conventions that a linter can check live here as rules, so a
 * break fails `npm test` and CI instead of waiting for a reviewer to notice it.
 *
 * Normally: every rule is an error. A rule that truly cannot apply on one line gets an inline
 * disable with a comment above it that says why.
 *
 * @author Patrick Finazzo
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const RESTRICTED_SYNTAX = [
  { selector: 'TSEnumDeclaration', message: 'Use a union of string literals or a lookup table, not an enum.' },
  { selector: 'TSInterfaceDeclaration', message: 'Use a `type` alias, not an interface.' },
];

// ESLint only loads a config file's default export, so this file is the one default export.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parserOptions: { project: ['./tsconfig.json', './tsconfig.renderer.json'], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': ['error', { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] }] }],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'separate-type-imports' }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'prefer-const': 'error',
      'no-var': 'error',
      'func-style': ['error', 'expression'],
      'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX],
      'no-restricted-exports': ['error', { restrictDefaultExports: { direct: true, named: true, defaultFrom: true, namedFrom: true, namespaceFrom: true } }],
    },
  },
);
