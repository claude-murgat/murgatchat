let mode = null;
let tauriNotify = null;

export function isTauri() {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

// ── Native window presence (Tauri only) ────────────────────────────────────
// The webview reports document.visibilityState = "visible" even when the OS
// window is hidden to the tray or minimised, so the activity heartbeat would
// keep telling the server "I'm here" — and because the push away-gate is
// per-user, an idle desktop sitting in the tray then SUPPRESSES push to the
// user's phone. Track the REAL native window state via the Tauri API instead.
let desktopForeground = true;

async function refreshDesktopForeground(win) {
  try {
    const visible = await win.isVisible().catch(() => true);
    const minimized = await win.isMinimized().catch(() => false);
    const fg = !!visible && !minimized;
    if (fg !== desktopForeground) {
      desktopForeground = fg;
      window.dispatchEvent(
        new CustomEvent("desktop:presence", { detail: { foreground: fg } })
      );
    }
  } catch {
    // Keep the last known state on any transient API error.
  }
}

async function initDesktopPresence() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await refreshDesktopForeground(win); // initial state (covers autostart --hidden)
    // Focus changes bracket every tray show/hide and minimise/restore.
    try {
      await win.onFocusChanged(() => refreshDesktopForeground(win));
    } catch {
      // Event listening unavailable — the poll below still keeps us in sync.
    }
    // Backstop for transitions that don't flip focus (e.g. hiding an already
    // unfocused window): re-check on a slow interval.
    setInterval(() => refreshDesktopForeground(win), 20_000);
  } catch (e) {
    console.warn("[desktop] presence tracking init failed:", e?.message || e);
  }
}

// True when the app is NOT in the foreground (so an away/push is warranted).
// Tauri: reflects the real native window (tray-hidden / minimised = away). In
// the browser/PWA the Page Visibility API is reliable, so use it directly.
export function isAppHidden() {
  if (isTauri()) return !desktopForeground;
  return typeof document !== "undefined" && document.visibilityState === "hidden";
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
    // Track real native-window visibility (tray hide / minimise) so the away
    // heartbeat is accurate — see isAppHidden(). Independent of notifications.
    initDesktopPresence();
    try {
      const mod = await import("@tauri-apps/plugin-notification");
      let granted = await mod.isPermissionGranted();
      if (!granted) {
        try {
          granted = (await mod.requestPermission()) === "granted";
        } catch {
          // Windows has no runtime prompt; treat a throw as "unknown", try anyway.
        }
      }
      tauriNotify = mod;
      // Keep tauri mode even if `granted` reads false: on Windows the permission
      // is frequently reported false while the OS still delivers toasts, and a
      // genuine denial just makes sendNotification a caught no-op below. Falling
      // back to the webview Notification API instead would show NOTHING on
      // Windows — strictly worse than trying. Warn (not log) when ungranted so a
      // desktop bug report captures it (the ring only keeps warn/error).
      if (granted) {
        console.log("[desktop] notifications ready (tauri, permission granted)");
      } else {
        console.warn(
          "[desktop] notifications: permission reads NOT granted — trying tauri toasts anyway (check Windows notification settings if none appear)"
        );
      }
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

// Desktop only: show (true) or clear (false) a red unread dot on the tray icon.
// No-op in the browser/PWA. Errors are swallowed — a missing tray must never
// break message handling.
export function setTrayBadge(unread) {
  if (!isTauri()) return;
  import("@tauri-apps/api/core")
    .then((mod) => mod.invoke("set_tray_badge", { unread: !!unread }))
    .catch((e) => console.error("[desktop] set_tray_badge failed:", e));
}

export function isWindowFocused() {
  if (typeof document === "undefined") return true;
  try {
    return document.hasFocus() && document.visibilityState !== "hidden";
  } catch {
    return true;
  }
}
