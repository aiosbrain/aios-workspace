// Flat ESLint config (ESLint 9). Lint inputs are passed explicitly by the `lint`
// npm script (`scripts validation gui/server gui/client/src test`) — scaffold/** is NOT
// linted (those are workspace templates, incl. the `.workflow.js` harnesses that rely on
// runtime-injected globals), so no harness-global override is needed here.
import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

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
  {
    // React/Vite frontend (browser).
    files: ["gui/client/src/**/*.{js,jsx}"],
    ...react.configs.flat.recommended,
    plugins: { ...react.configs.flat.recommended.plugins, "react-hooks": reactHooks },
    languageOptions: {
      ...react.configs.flat.recommended.languageOptions,
      ecmaVersion: 2023,
      sourceType: "module",
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
];
