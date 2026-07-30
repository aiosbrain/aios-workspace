// Flat ESLint config (ESLint 9). Lint inputs are passed explicitly by the `lint`
// npm script (`scripts validation gui/server gui/client/src src test`) — scaffold/** is NOT
// linted (those are workspace templates, incl. the `.workflow.js` harnesses that rely on
// runtime-injected globals), so no harness-global override is needed here.
// TypeScript (src/operator-loop, src/timeline, gui/client/src) is linted with the
// typescript-eslint recommended config in NON-type-checked mode (no tsc program) to keep
// CI cheap (AIO-598).
import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "node_modules/**",
      "**/dist/**",
      "src-tauri/target/**",
      "scaffold/**",
      "examples/**",
      "**/*.min.js",
    ],
  },
  js.configs.recommended,
  {
    // First-party Node sources (CLI, validators, harnesses, GUI server, tests).
    files: ["**/*.{js,mjs,jsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Allow intentionally-unused via leading underscore; don't flag unused catch bindings.
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  // TypeScript — recommended (non-type-checked; no tsc program in lint), scoped to TS files.
  ...tseslint.configs.recommended.map((cfg) => ({
    ...cfg,
    files: ["**/*.{ts,tsx,mts}"],
  })),
  {
    // TS sources run under Node (operator loop, timeline) or Vite; Node globals here,
    // browser globals added for the GUI client below.
    files: ["**/*.{ts,tsx,mts}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Mirror the JS unused-vars convention (leading underscore = intentional).
      // warn (not error): 5 pre-existing violations in src/operator-loop at TS-lint adoption (AIO-598).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // warn: 1 pre-existing violation (src/operator-loop/connectors.ts) at TS-lint adoption (AIO-598).
      "prefer-const": "warn",
    },
  },
  {
    // React/Vite frontend (browser) — JS and TS variants.
    files: ["gui/client/src/**/*.{js,jsx,ts,tsx}"],
    plugins: { ...react.configs.flat.recommended.plugins, "react-hooks": reactHooks },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "react/react-in-jsx-scope": "off", // React 19 automatic JSX runtime
      "react/prop-types": "off",
      "react/no-unescaped-entities": "off", // noisy on prose copy; harmless entities
    },
  },
  {
    // Pre-existing violations in the newly-linted TSX cockpit (AIO-598): downgraded to warn,
    // NOT disabled, so new code still gets flagged and the counts stay visible. JS/JSX files
    // keep these at their recommended (error) severity.
    files: ["gui/client/src/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/set-state-in-effect": "warn", // 15 pre-existing at adoption
      "react-hooks/refs": "warn", // 4 pre-existing at adoption
      "react-hooks/purity": "warn", // 1 pre-existing at adoption
      "react-hooks/immutability": "warn", // 1 pre-existing at adoption
      "react-hooks/preserve-manual-memoization": "warn", // 1 pre-existing at adoption
      "react/no-unknown-property": "warn", // 1 pre-existing (cmdk-input-wrapper attr) at adoption
    },
  },
  {
    // Complexity budgets (AIO-598): WARN-only codebase-health signal, never errors.
    files: ["**/*.{js,mjs,jsx,ts,tsx,mts}"],
    rules: {
      complexity: ["warn", 20],
      "max-depth": ["warn", 4],
      "max-lines-per-function": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
      "max-params": ["warn", 5],
    },
  },
];
