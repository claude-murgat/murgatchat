let mode = null;
let tauriNotify = null;

export function isTauri() {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

// Open an external URL in the OS default browser via the opener plugin.
// Exported so buttons (not just <a> links) can reach the browser under Tauri —
// window.open is swallowed by the webview (same root cause as #43).
export function openExternal(url) {
  import("@tauri-apps/plugin-opener")
    .then((mod) => mod.openUrl(url))
    .catch((e) => console.error("[desktop] openUrl failed:", e));
}

// Under Tauri, <a target="_blank"> / external links don't reach the OS — the
// webview just swallows them, so message links and attachment download links
// did nothing (#43). Delegate clicks once on the document and route absolute
// http(s) links to the default browser. The plain browser build never calls
// this, so target="_blank" keeps working natively there.
let externalLinksBound = false;
function initExternalLinks() {
  if (externalLinksBound || typeof document === "undefined") return;
  externalLinksBound = true;
  document.addEventListener("click", (e) => {
    // Leave modifier-clicks and already-handled events alone.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    const anchor = e.target?.closest?.("a[href]");
    if (!anchor) return;
    // Only absolute http(s) URLs go to the browser — covers message links AND
    // attachment links (they point at the server origin). In-app relative/hash
    // navigation is left untouched.
    const href = anchor.getAttribute("href") || "";
    if (!/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    openExternal(anchor.href);
  });
}

async function init() {
  if (isTauri()) {
    // Bind the external-link handler first, independent of the notification
    // permission flow below (which can early-return).
    initExternalLinks();
    try {
      const mod = await import("@tauri-apps/plugin-notification");
      const granted = await mod.isPermissionGranted();
      if (!granted) {
        const perm = await mod.requestPermission();
        if (perm !== "granted") return null;
      }
      tauriNotify = mod;
      return "tauri";
    } catch (e) {
      console.error("[desktop] tauri notification init failed:", e);
    }
  }
  if (typeof window !== "undefined" && "Notification" in window) {
    if (Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch {}
    }
    if (Notification.permission === "granted") return "browser";
  }
  return null;
}

const ready = init().then((m) => {
  mode = m;
  return m;
});

export async function ensureReady() {
  return ready;
}

export async function notify(title, body) {
  await ready;
  if (mode === "tauri" && tauriNotify) {
    try {
      await tauriNotify.sendNotification({ title, body });
    } catch (e) {
      console.error("[desktop] sendNotification failed:", e);
    }
    return;
  }
  if (mode === "browser" && Notification.permission === "granted") {
    try {
      new Notification(title, { body });
    } catch (e) {
      console.error("[desktop] Notification failed:", e);
    }
  }
}

export function isWindowFocused() {
  if (typeof document === "undefined") return true;
  try {
    return document.hasFocus() && document.visibilityState !== "hidden";
  } catch {
    return true;
  }
}
