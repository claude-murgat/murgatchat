// Flat ESLint config (ESLint v10) for the Node/Express API (ESM).
// Kept lean and correctness-focused: the recommended ruleset plus unused-var
// hygiene. Everything enforced is an `error` (no warning tier) so `npm run lint`
// is a clean pass/fail gate in CI.
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "data/**", "prisma/migrations/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Allow intentionally-unused args/vars when prefixed with `_`.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];
