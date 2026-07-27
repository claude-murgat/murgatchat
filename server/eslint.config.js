// Flat ESLint config (ESLint v10) for the Node/Express API (ESM, TypeScript).
// Kept lean and correctness-focused: the recommended ruleset plus unused-var
// hygiene. Everything enforced is an `error` (no warning tier) so `npm run lint`
// is a clean pass/fail gate in CI.
//
// `server/src` est en TypeScript depuis la phase 3. Sans le parseur de
// typescript-eslint, ESLint ne sait pas lire ces fichiers et les IGNORE
// silencieusement — le gate passerait alors à vide. Le bloc `**/*.ts` ci-dessous
// est donc ce qui garantit que le lint couvre réellement le serveur.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["node_modules/**", "data/**", "prisma/migrations/**", "coverage/**"],
  },
  js.configs.recommended,

  // Sources TypeScript (server/src).
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ["**/*.ts"] })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // La règle de base fait doublon sur du TypeScript : c'est la version
      // typescript-eslint qui s'applique, avec la même tolérance pour `_`.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Fichiers JavaScript restants (scripts, fichiers de configuration, tests).
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
