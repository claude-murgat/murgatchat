// Déclarations d'ambiance pour l'analyse de types (phase 2). AUCUN code à
// l'exécution : un `.d.ts` ne décrit que des types, il n'est ni bundlé ni exécuté
// — le projet reste 100 % JS/JSX.
//
// Sans ce fichier, tout fichier passé en `// @ts-check` signalerait à tort
// `import.meta.env`, `__APP_VERSION__` ou les globaux propres à la plateforme.

/// <reference types="vite/client" />

// Injecté au build par Vite (`define` dans vite.config.js).
declare const __APP_VERSION__: string;

interface Navigator {
  /** iOS Safari : vrai quand l'app est lancée depuis l'écran d'accueil (PWA). */
  standalone?: boolean;
}

interface Window {
  /** Présent uniquement dans le webview Tauri (build desktop). */
  __TAURI__?: unknown;
}
