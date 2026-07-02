// Flat ESLint config (ESLint v9) for the Vite + React 18 web app (ESM).
// Correctness-focused: JS recommended + React + Rules of Hooks. The JSX runtime
// config disables the legacy "React must be in scope" rules (Vite's automatic
// runtime). prop-types is off (the codebase doesn't use them).
import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "dist/**",
      "dev-dist/**",
      "node_modules/**",
      "src-tauri/**",
      "public/**",
    ],
  },
  js.configs.recommended,

  // Application source: browser runtime + JSX.
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        // Injected at build time by Vite's `define` (see vite.config.js).
        __APP_VERSION__: "readonly",
      },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs["jsx-runtime"].rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react/prop-types": "off",
      // Apostrophes in JSX text are fine (lots of French copy: « l'inscription »).
      "react/no-unescaped-entities": "off",
      // Empty catch blocks are an intentional "swallow" idiom used throughout.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Allow intentionally-unused args and PascalCase/UPPER imports (components,
      // constants) ESLint can't always see used in JSX; ignoreRestSiblings covers
      // the `{ node, ...props }` pattern that deliberately drops a prop.
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^[A-Z_]", ignoreRestSiblings: true },
      ],
    },
  },

  // Service worker: its own global scope (self, caches, clients, …).
  {
    files: ["src/sw.js"],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.browser },
    },
  },

  // Build/tooling config files run under Node.
  {
    files: ["*.config.{js,mjs,cjs}"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.node },
    },
  },

  // One-off Node build scripts (e.g. icon generation, CommonJS).
  {
    files: ["scripts/**"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
