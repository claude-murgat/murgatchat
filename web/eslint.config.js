// Flat ESLint config (ESLint v10) for the Vite + React 19 web app (ESM).
// Correctness-focused: JS recommended + @eslint-react + Rules of Hooks.
//
// Pourquoi @eslint-react et non eslint-plugin-react : ce dernier plafonne sa
// peer dep à `eslint@^9.7` et aucune version publiée ne supporte ESLint 10, ce
// qui gelait tout le lint du web. @eslint-react est la réécriture moderne,
// pensée pour TypeScript (utile pour la migration en cours) et sans contrainte
// de version d'ESLint. Ses règles remplacent l'ancien jeu `recommended` ; les
// règles héritées des composants de classe disparaissent d'elles-mêmes (le code
// est 100 % hooks) et prop-types n'existe plus (jamais utilisé ici).
import js from "@eslint/js";
import globals from "globals";
import eslintReact from "@eslint-react/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const react = eslintReact.configs.recommended;

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

  // Parseur TypeScript : sans lui, ESLint ignore SILENCIEUSEMENT les .ts/.tsx
  // et le gate CI passerait à vide (piège rencontré côté serveur).
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ["**/*.{ts,tsx}"] })),

  // Application source: browser runtime + JSX.
  {
    files: ["src/**/*.{js,jsx,ts,tsx}"],
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
    plugins: { ...react.plugins, "react-hooks": reactHooks },
    settings: { ...react.settings },
    rules: {
      ...react.rules,
      // Évite le double signalement : @eslint-react embarque des règles qui
      // recouvrent celles de eslint-plugin-react-hooks, qu'on garde comme
      // référence pour les Rules of Hooks.
      ...eslintReact.configs["disable-conflict-eslint-plugin-react-hooks"].rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Purement stylistique (impose de nommer un ref `ref` ou `*Ref`) : aucune
      // valeur de correction, et le dépôt a déjà sa propre convention. Coupée
      // pour ne pas noyer les avertissements qui, eux, signalent de vrais
      // problèmes (impureté de rendu, fuites de timeout/fetch, clés d'index…).
      "@eslint-react/naming-convention-ref-name": "off",
      // Empty catch blocks are an intentional "swallow" idiom used throughout.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Allow intentionally-unused args and PascalCase/UPPER imports (components,
      // constants) ESLint can't always see used in JSX; ignoreRestSiblings covers
      // the `{ node, ...props }` pattern that deliberately drops a prop.
      // Ternaire utilisé comme instruction (`cond ? a() : b()`) : idiome présent
      // dans le dépôt, volontairement toléré.
      "@typescript-eslint/no-unused-expressions": ["error", { allowTernary: true }],
      // Signalé sans bloquer : les rares `any` restants sont commentés sur place.
      "@typescript-eslint/no-explicit-any": "warn",
      // Sur du TypeScript, la règle de base fait doublon et compte mal (imports
      // de type, surcharges) : c'est la version typescript-eslint qui s'applique.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^[A-Z_]", ignoreRestSiblings: true },
      ],
    },
  },

  // Service worker: its own global scope (self, caches, clients, …).
  {
    files: ["src/sw.ts"],
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
