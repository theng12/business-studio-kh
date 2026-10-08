import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * ESLint config — added 2026-09-19.
 *
 * Why this exists: a fatal bug shipped in v0.1.8 that referenced a variable
 * which did not exist (`canvasH`). Clicking "+ Barcode" in Overlay Studio
 * dropped the whole editor into its error boundary. 190 unit tests passed
 * anyway, because they only cover main-process utilities and never render a
 * component. A linter catches that class of mistake in under a second.
 *
 * Scope is deliberately narrow. This is a large, working codebase and the
 * goal is to catch REAL BUGS, not to relitigate style — so only correctness
 * rules are on. Formatting opinions would produce hundreds of findings and
 * teach everyone to ignore the output.
 *
 *   no-undef        — use of a name that isn't defined anywhere. THE rule that
 *                     matters; it is what the v0.1.8 crash was.
 *   no-const-assign — assigning to a const (always a bug)
 *   no-dupe-keys    — duplicate key in an object literal
 *   no-dupe-args    — duplicate function parameter
 *   no-unreachable  — code after a return/throw that can never run
 *   no-obj-calls    — calling a non-function built-in like Math()
 *   no-cond-assign  — assignment where a comparison was meant
 *   valid-typeof    — typeof compared against a typo'd string
 *   no-empty        — see the note below
 *   no-unused-vars  — see the note below
 *
 * The last two are set to "warn", not "error": there are legitimate empty
 * catch blocks (best-effort cleanup) and legitimately unused values
 * (destructuring a rest object to drop keys). They were used to AUDIT the
 * codebase — the warnings are how the error-swallowing sweep found its
 * targets — but they must not fail the build.
 */

/** Rules that indicate a genuine mistake. These fail. */
const correctness = {
  'no-undef': 'error',
  'no-const-assign': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-unreachable': 'error',
  'no-obj-calls': 'error',
  'no-cond-assign': 'error',
  'valid-typeof': 'error',
  'no-unsafe-negation': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-self-assign': 'error',
  'no-sparse-arrays': 'error',
  'use-isnan': 'error',
  'no-template-curly-in-string': 'warn',
};

const style = {
  'no-empty': ['warn', { allowEmptyCatch: true }],
  // `console.log` left in by accident is noise; console.error/warn are the
  // deliberate troubleshooting channel this codebase already uses (and several
  // files carry an inline disable for exactly that). Enabled so those existing
  // directives are meaningful again rather than reading as stale.
  'no-console': ['warn', { allow: ['error', 'warn'] }],
  // NOTE: `no-await-in-loop` is deliberately NOT enabled. Sequential awaits
  // are the intended pattern throughout this codebase (the AI queue runner
  // processes tasks one at a time, the webclient bundler walks a file list) —
  // turning it on produced ~90 warnings that were all intentional. The two
  // inline disables it once required in renderer/lib/spinExport.js were removed
  // along with the other stale directives; the reasoning they carried now sits
  // as a plain comment on each loop.
  // An assignment whose value is never used before being overwritten — dead
  // code left behind by a refactor. Harmless at runtime, which is why it is a
  // warning rather than a failure: it is a signal to tidy, not a bug.
  'no-useless-assignment': 'warn',
  'no-unused-vars': ['warn', {
    args: 'none',
    caughtErrors: 'none',
    ignoreRestSiblings: true,
    varsIgnorePattern: '^_',
  }],
};

export default [
  {
    ignores: [
      'node_modules/**', 'dist/**', 'dist-electron/**', 'dist-renderer/**',
      'graphify-out/**', 'build/**', 'assets/**', 'data/**',
      // The catalogue viewer is one HTML file (no .js to lint); the fuel phone
      // page's scripts ARE linted, by the webclient/fuel block below.
      'webclient/*', '!webclient/fuel/',
      // `_trash/` is the owner's recoverable-delete folder — nothing in it is
      // read by the app, tests or build, so lint must not scan it either.
      '_trash/**',
    ],
  },
  js.configs.recommended,

  // ── Main process: CommonJS, Node ──────────────────────────────────────
  {
    files: ['main/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { ...correctness, ...style },
  },

  // ── Build scripts: printing to the terminal is their whole job ────────
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { ...correctness, ...style, 'no-console': 'off' },
  },

  // ── Build/config files at the repo root: ESM, Node ────────────────────
  // (vite.config.js is ESM and uses __dirname — it needs the Node globals,
  // not the browser ones, or no-undef reports nine false positives.)
  {
    files: ['*.js', '*.mjs', '*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { ...correctness, ...style },
  },

  // ── Fuel phone page (/f): classic browser scripts, inlined into one HTML ─
  // logic.js is also required by node:test, hence `module`.
  {
    files: ['webclient/fuel/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: { ...globals.browser, module: 'readonly' },
    },
    rules: { ...correctness, ...style },
  },

  // ── Renderer: ES modules, browser, JSX ────────────────────────────────
  {
    files: ['renderer/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...correctness,
      ...style,
      // Real hook bugs: a hook called conditionally, or a missing dependency.
      // rules-of-hooks is an error because it is a genuine correctness bug.
      // exhaustive-deps stays a warning, and the 13 it reports are LEFT
      // VISIBLE on purpose — they are not suppressed anywhere. Each one is a
      // "this effect reads a value it does not declare" decision that has to be
      // made per case: adding the dependency is often right, but on an effect
      // that sets state it can loop forever. Silencing them wholesale would
      // hide the next genuine stale-closure bug; the list is the to-do.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ── The changelog: `${…}` in here is documentation, not interpolation ──
  // WhatsNewModal.jsx is one long array of user-facing release notes written as
  // literal strings. A few entries quote a build setting verbatim — e.g.
  // `${productName}-${version}-${arch}` — and those trip
  // no-template-curly-in-string, whose real purpose is to catch a `${…}` that was
  // MEANT to be a template literal. In a changelog the opposite reading is the
  // safe one: an interpolated string here would render raw to the user, which is
  // precisely what the rule exists to prevent, so there is nothing accidental
  // for it to catch. Everywhere else in the renderer it stays on.
  {
    files: ['renderer/components/WhatsNewModal.jsx'],
    rules: { 'no-template-curly-in-string': 'off' },
  },
];
