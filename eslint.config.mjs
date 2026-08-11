import security from 'eslint-plugin-security';

const sharedRules = {
  // Security rules
  // detect-object-injection disabled: 78 false positives from config lookups like obj[hosterName]
  'security/detect-object-injection': 'off',
  'security/detect-non-literal-regexp': 'warn',
  'security/detect-unsafe-regex': 'warn',
  'security/detect-buffer-noassert': 'warn',
  'security/detect-eval-with-expression': 'error',
  'security/detect-no-csrf-before-method-override': 'warn',
  'security/detect-possible-timing-attacks': 'warn',
  'security/detect-pseudoRandomBytes': 'warn',
  // Code quality
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'error',
  'no-constant-condition': 'warn',
  'no-debugger': 'error',
  'no-duplicate-case': 'error',
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-ex-assign': 'error',
  'no-extra-boolean-cast': 'warn',
  'no-func-assign': 'error',
  'no-inner-declarations': 'error',
  'no-irregular-whitespace': 'error',
  'no-unreachable': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'eqeqeq': ['warn', 'always'],
  'no-caller': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-throw-literal': 'warn',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-loss-of-precision': 'error',
  'no-dupe-keys': 'error',
  'no-unsafe-finally': 'error',
  'no-unmodified-loop-condition': 'warn',
  'no-template-curly-in-string': 'warn',
};

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  crypto: 'readonly',
  structuredClone: 'readonly',
  performance: 'readonly',
};

export default [
  { ignores: ['**/node_modules/**', 'release/**', 'tests/**', '.artifacts/**', '.worktrees/**', 'test-artifacts/**'] },
  {
    files: ['**/*.js'],
    ignores: ['gateway/**'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        ...nodeGlobals,
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        navigator: 'readonly',
        document: 'readonly',
        window: 'readonly',
        localStorage: 'readonly',
        HTMLElement: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        requestAnimationFrame: 'readonly',
        queueMicrotask: 'readonly',
        Intl: 'readonly',
        EventSource: 'readonly',
      }
    },
    rules: sharedRules
  },
  {
    files: ['gateway/**/*.js', 'gateway/**/*.mjs'],
    ignores: ['gateway/node_modules/**'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: nodeGlobals
    },
    rules: sharedRules
  },
  {
    files: ['lib/diagnostics-collectors.js', 'lib/log-mode.js', 'lib/support-bundle.js'],
    rules: {
      'security/detect-unsafe-regex': 'off'
    }
  }
];
