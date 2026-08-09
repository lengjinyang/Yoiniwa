import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const tsFiles = ['src/**/*.{ts,tsx}'];
const jsFiles = ['scripts/**/*.mjs'];

export default tseslint.config(
  {
    ignores: [
      'dist/**', 'release/**', 'src-tauri/target/**', 'node_modules/**', 'performance-results/**',
      '.project-bench-user-data*/**', '.refcanvas-test-session/**',
    ],
  },
  { ...eslint.configs.recommended, files: jsFiles },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: tsFiles })),
  {
    files: tsFiles,
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
    },
  },
  {
    files: jsFiles,
    languageOptions: {
      globals: {
        AbortSignal: 'readonly', Buffer: 'readonly', Response: 'readonly', URL: 'readonly', console: 'readonly',
        fetch: 'readonly', process: 'readonly', require: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        performance: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-constant-condition': 'off',
    },
  },
);
