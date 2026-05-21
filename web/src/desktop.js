let mode = null;
let tauriNotify = null;

export function isTauri() {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

async function init() {
  if (isTauri()) {
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
