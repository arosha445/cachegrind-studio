import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Invariant 2: the parser is shared by the browser Worker, the MCP server
    // and any future CLI. The moment it reaches for React, the DOM, or a Node
    // builtin, one of those three consumers breaks. Enforced here rather than
    // left to review.
    files: ['packages/parser/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@cachegrind-studio/web', '@cachegrind-studio/web/*', 'react', 'react-dom'],
              message:
                'packages/parser must not depend on the UI. If you need something from the web package, the abstraction belongs in the parser instead.',
            },
            {
              group: ['node:*', 'fs', 'path', 'os', 'crypto', 'worker_threads'],
              message:
                'packages/parser must run in a browser Worker. Node builtins are not available there.',
            },
            {
              group: ['../../*'],
              message: 'packages/parser must not reach outside its own package.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'packages/parser must not touch the DOM.' },
        { name: 'window', message: 'packages/parser must not touch the DOM.' },
        { name: 'navigator', message: 'packages/parser must stay environment-agnostic.' },
        { name: 'process', message: 'packages/parser must not assume Node.' },
        { name: 'require', message: 'packages/parser is ESM only.' },
      ],
      // Invariant: no `any` in the parser.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.bench.ts', 'fixtures/**/*.mjs'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
    },
  },
);
