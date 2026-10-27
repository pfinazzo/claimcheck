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

const VERB_PREFIX = '^(to|build|calculate|is|has|can|should|fetch|create|update|save|delete|handle|use|on|render|parse|format|read|write|run|resolve|find|load|open|close|start|stop|check|apply|make|set|add|remove|draft|send|select|show|hide|mount|wire|ensure|validate|normalize|merge|strip|escape|redact|watch|spawn|wait|sleep|list|pick|clamp|count|mask|init|reset|install|detect|compute|collect|extract|split|join|trim|sort|filter|map|emit|record|append|replace|attach|toggle|exit|next|back|answer|freeze|plant|kill|fix|go|request|launch|ask|summarize|describe|truncate|hash|assert|expect|copy|wrap|unwrap|connect|accept|reject|draw|refresh|register|keep|drop|skip|cancel|retry|poll|log|throw|fail|pass|clean|test|sha)';

const RESTRICTED_SYNTAX = [
  { selector: 'TSEnumDeclaration', message: 'Use a union of string literals or a lookup table, not an enum.' },
  { selector: 'TSInterfaceDeclaration', message: 'Use a `type` alias, not an interface.' },
  { selector: 'TSAsExpression > TSAsExpression', message: 'Never double-cast through unknown; narrow the value instead.' },
  { selector: 'SwitchStatement', message: 'Use a lookup table, not a switch.' },
  { selector: 'MemberExpression[property.name="then"]', message: 'Use await, not .then().' },
  { selector: 'CatchClause > BlockStatement[body.length=0]', message: 'Never swallow an error. Recover with a named fallback, or rethrow with context.' },
  { selector: 'ClassDeclaration:not([superClass.name="Error"])', message: 'Use plain functions and modules, not classes. Only error types may be classes.' },
  { selector: 'ClassExpression', message: 'Use plain functions and modules, not classes.' },
  { selector: 'TSPropertySignature > TSTypeAnnotation > TSArrayType', message: 'Array fields are readonly: write `readonly T[]`.' },
  { selector: 'CallExpression[callee.property.name=/^(push|splice|sort|reverse|unshift|shift|pop)$/]', message: 'Never mutate arrays. Use map/filter/reduce, spread, toSorted or toReversed.' },
  { selector: 'Program > VariableDeclaration[kind="let"], ExportNamedDeclaration > VariableDeclaration[kind="let"]', message: 'No shared mutable module state. Pass state through arguments and return values.' },
  { selector: 'VariableDeclarator > ArrowFunctionExpression[params.length>1]', message: 'Named params, not positional: take one options object.' },
  { selector: 'VariableDeclarator > ArrowFunctionExpression[params.0.type="Identifier"]', message: 'Named params, not positional: take one options object, even for one argument.' },
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
      '@typescript-eslint/require-await': 'error',
      'max-depth': ['error', 2],
      'no-nested-ternary': 'error',
      'no-await-in-loop': 'error',
      'no-inline-comments': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'prefer-const': 'error',
      'no-var': 'error',
      'func-style': ['error', 'expression'],
      'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX],
      '@typescript-eslint/naming-convention': ['error',
        { selector: 'variable', types: ['function'], modifiers: ['global'], format: null, custom: { regex: VERB_PREFIX, match: true } },
        { selector: 'variable', types: ['boolean'], format: null, custom: { regex: '^(is|has|can|should|was|did|will)[A-Z]|^[A-Z_]+$', match: true } },
      ],
      'id-length': ['error', { min: 3, exceptions: ['_', 'id', 'ok', 'fs', 'os', 'gh', 'ui', 'cc', 'to', 'at', 'by', 'on', 'acc', 'x', 'y'], properties: 'never' }],
      'id-denylist': ['error', 'data', 'info', 'item', 'obj', 'temp', 'tmp', 'result', 'res', 'val', 'str', 'arr', 'el', 'cb', 'fn', 'buf', 'idx', 'err', 'ctx', 'cfg', 'opts', 'args', 'msg', 'manager', 'helper', 'util'],
      'no-restricted-exports': ['error', { restrictDefaultExports: { direct: true, named: true, defaultFrom: true, namedFrom: true, namespaceFrom: true } }],
    },
  },
);
