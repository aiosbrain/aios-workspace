// Flat ESLint config (ESLint 9). Lint inputs are passed explicitly by the `lint`
// npm script (`scripts validation src test packages`) — scaffold/** is NOT
// linted (those are workspace templates, incl. the `.workflow.js` harnesses that rely on
// runtime-injected globals), so no harness-global override is needed here.
// The React/Vite frontend blocks left with gui/client in the AIO-612 cut; that config now
// lives in aiosbrain/aios-workspace-gui.
// TypeScript (src/operator-loop, src/timeline) is linted with the
// typescript-eslint recommended config in NON-type-checked mode (no tsc program) to keep
// CI cheap (AIO-598).
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["node_modules/**", "**/dist/**", "scaffold/**", "examples/**", "**/*.min.js"],
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
