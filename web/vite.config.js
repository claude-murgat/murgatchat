import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { VitePWA } from "vite-plugin-pwa";

// Bake the app version (from package.json) into the bundle so the running
// client can compare itself to the server-advertised version (GET /version).
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // injectManifest mode: we write our own service worker (in src/sw.js)
      // because we need a `push` event handler with the test_pwa-validated iOS
      // quirks (mandatory showNotification, defensive payload parse, deep-link
      // recovery via Cache Storage). The plugin still injects the precache
      // manifest into our SW via `self.__WB_MANIFEST`.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.js",
      // The SW must live at /sw.js so it can control the whole origin scope.
      // PWA SW URL is `/sw.js`; the dist build copies it to dist/sw.js.
      injectRegister: false, // we register manually from src/pwa.js (better
      // control over the timing — only after the user logs in and grants the
      // notification permission, we don't want to subscribe anonymous users).
      manifest: {
        name: "Murgat Chat",
        short_name: "Chat",
        description: "Messagerie d'équipe Murgat — installez sur votre écran d'accueil pour recevoir les notifications.",
        lang: "fr",
        start_url: "/?source=pwa",
        scope: "/",
        display: "standalone",
        display_override: ["standalone", "minimal-ui", "browser"],
        orientation: "portrait",
        theme_color: "#3F0E40",
        background_color: "#3F0E40",
        categories: ["productivity", "social"],
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      injectManifest: {
        // The precache manifest covers the app shell so it boots offline on
        // returning visits. Keep the bundle limit generous — react-markdown +
        // highlight.js are chunky.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: {
        // Allow testing the SW + manifest with `vite dev` (otherwise PWA only
        // activates on `vite build` + `vite preview`).
        enabled: true,
        type: "module",
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
});
