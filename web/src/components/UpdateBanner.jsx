import { useState } from "react";
import { isTauri, openExternal } from "../desktop.js";

// Shown when the server advertises a newer version. Position: top on
// desktop/tablet; on mobile web/PWA it sits at the BOTTOM (out of the way of the
// header, within thumb reach) — see `layout` below.
// - Web   : a new bundle is deployed → "Rafraîchir" does a cache-bypassing
//   reload (the PWA service worker would otherwise re-serve the cached old shell).
// - Desktop: the app is installed → "Télécharger" opens the release page so the
//   user can grab the new installer (refreshing wouldn't change the bundled app).

// Behave like Ctrl/Cmd+F5: a plain location.reload() re-serves the SW-precached
// (old) bundle, so the banner kept reappearing. Drop the caches + nudge the SW
// so the reload fetches the freshly-deployed assets from the network. The version
// banner is server-driven (/version), so there's usually no "waiting" worker yet —
// clearing caches is what reliably forces fresh assets, independent of SW timing.
async function hardReload() {
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if (typeof navigator !== "undefined" && navigator.serviceWorker) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg?.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
      if (reg) reg.update().catch(() => {});
    }
  } catch {
    /* fall through to a plain reload */
  }
  window.location.reload();
}

export default function UpdateBanner({ info, onDismiss, onDesktopInstall }) {
  const [busy, setBusy] = useState(false);
  if (!info?.updateAvailable) return null;
  const desktop = isTauri();
  // Desktop with the Tauri updater wired: the button installs in place + relaunches.
  // Without it (older path), fall back to opening the release download page.
  const canAutoUpdate = desktop && typeof onDesktopInstall === "function";

  // The banner is a direct flex child of the app's column layout, so `order`
  // alone repositions it. On web/PWA: bottom on mobile (order-last), top from
  // `md` up. Under Tauri it stays at the top. Border flips to match the edge.
  const layout = desktop
    ? "border-b"
    : "order-last md:order-none border-t md:border-b";

  async function action() {
    if (canAutoUpdate) {
      setBusy(true);
      try {
        await onDesktopInstall(); // downloads, installs, relaunches (or throws)
      } finally {
        setBusy(false);
      }
    } else if (desktop) {
      // Route through the opener plugin: under Tauri, window.open is swallowed by
      // the webview (#43) so the button did nothing. openExternal hits the OS browser.
      openExternal(info.downloadUrl);
    } else {
      hardReload();
    }
  }

  return (
    <div
      className={`bg-amber-100 ${layout} border-amber-300 text-amber-900 px-4 py-2 text-sm flex items-center gap-3`}
      style={
        desktop ? undefined : { paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }
      }
    >
      <span className="font-semibold">Nouvelle version disponible ({info.latest})</span>
      <span className="opacity-80 hidden sm:inline">
        {canAutoUpdate
          ? "Elle sera installée et l'application redémarrera."
          : desktop
          ? "Téléchargez le nouvel installeur pour mettre à jour."
          : "Rafraîchissez la page pour l'utiliser."}
      </span>
      <button
        onClick={action}
        disabled={busy}
        className="ml-auto px-3 py-1 rounded-md bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-60"
      >
        {canAutoUpdate
          ? busy
            ? "Installation…"
            : "Installer"
          : desktop
          ? "Télécharger"
          : "Rafraîchir"}
      </button>
      {desktop && !canAutoUpdate && (
        <a
          href={info.downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs underline text-amber-800 break-all hidden md:inline"
        >
          {info.downloadUrl}
        </a>
      )}
      <button
        onClick={onDismiss}
        title="Masquer"
        className="text-amber-700 hover:text-amber-900 px-1"
      >
        ✕
      </button>
    </div>
  );
}
