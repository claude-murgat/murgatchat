let mode = null;

export function isTauri() {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

// ── Native window presence (Tauri only) ────────────────────────────────────
// The webview keeps document.visibilityState = "visible" AND document.hasFocus()
// = true even when the OS window is hidden to the tray or minimised. That breaks
// TWO things at once:
//   • the activity heartbeat keeps telling the server "I'm here", so an idle
//     desktop in the tray suppresses push to the user's phone; and
//   • isWindowFocused() wrongly reports the user is looking at the app, so
//     onNotif skips BOTH the toast and the tray badge ("not even a red dot").
// Track the REAL native window state via the Tauri API and drive both off it.
let desktopVisible = true;
let desktopFocused = true;

async function refreshDesktopState(win, focusedHint) {
  try {
    const visible = await win.isVisible().catch(() => true);
    const minimized = await win.isMinimized().catch(() => false);
    const vis = !!visible && !minimized;
    const foc =
      typeof focusedHint === "boolean"
        ? focusedHint
        : await win.isFocused().catch(() => desktopFocused);
    if (vis !== desktopVisible || foc !== desktopFocused) {
      desktopVisible = vis;
      desktopFocused = foc;
      window.dispatchEvent(
        new CustomEvent("desktop:presence", { detail: { visible: vis, focused: foc } })
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
    await refreshDesktopState(win); // initial state (covers autostart --hidden)
    // onFocusChanged brackets every tray show/hide and minimise/restore, and
    // carries the new focus state directly.
    try {
      await win.onFocusChanged(({ payload: focused }) => refreshDesktopState(win, focused));
    } catch {
      // Event listening unavailable — the poll below still keeps us in sync.
    }
    // Backstop for transitions that don't flip focus (e.g. hiding an already
    // unfocused window): re-check on a slow interval.
    setInterval(() => refreshDesktopState(win), 20_000);
  } catch (e) {
    console.warn("[desktop] presence tracking init failed:", e?.message || e);
  }
}

// Relaie le clic sur une notification desktop : la commande Rust `notify_desktop`
// (re)met la fenêtre au premier plan puis émet l'événement Tauri
// `desktop:notification-click` avec l'id du salon. On le convertit en CustomEvent
// fenêtre (même pont que desktop:presence) pour qu'App.jsx ouvre la conversation.
async function initNotificationClicks() {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen("desktop:notification-click", (event) => {
      window.dispatchEvent(
        new CustomEvent("desktop:notification-click", {
          detail: { channelId: event.payload || null },
        })
      );
    });
  } catch (e) {
    console.warn("[desktop] notification-click listener init failed:", e?.message || e);
  }
}

// True when the app is NOT in the foreground (so an away/push is warranted).
// Tauri: reflects the real native window (tray-hidden / minimised = away). In
// the browser/PWA the Page Visibility API is reliable, so use it directly.
export function isAppHidden() {
  if (isTauri()) return !desktopVisible;
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
    // Bridge Rust notification-click activations to a window CustomEvent (#169 desktop).
    initNotificationClicks();
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

// `onClick` (optionnel) : rappel exécuté au clic sur la notification (ramener la
// fenêtre + ouvrir la bonne conversation, #169). En navigateur/PWA on privilégie
// la notification PERSISTANTE du service worker, dont le clic reste fiable même
// depuis le Centre de notifications Windows (#190) ; `onClick` ne sert plus que
// de repli (notification in-page) quand aucun SW n'est actif. Sous Tauri,
// l'activation passe par le tray (hors périmètre ici).
export async function notify(title, body, onClick, channelId) {
  await ready;
  if (mode === "tauri") {
    // Toast natif via une commande Rust (`notify_desktop`) : le plugin
    // tauri-plugin-notification ne remonte pas le clic côté desktop. Le clic
    // ramène la fenêtre et émet l'événement `desktop:notification-click` (relayé
    // en CustomEvent par initNotificationClicks) avec l'id du salon pour naviguer.
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("notify_desktop", { title, body, channelId: channelId ?? null });
    } catch (e) {
      console.error("[desktop] notify_desktop failed:", e);
    }
    return;
  }
  if (mode === "browser" && Notification.permission === "granted") {
    // Chemin privilégié : la notification PERSISTANTE du service worker.
    // Contrairement à `new Notification()` (non-persistant), son clic est délivré
    // par le handler `notificationclick` du SW même quand le toast a basculé dans
    // le Centre de notifications Windows — où `Notification.onclick` ne se
    // déclenche jamais (bug #190). Le SW refocalise la fenêtre et deep-linke via
    // `?channel=<id>` (exactement le même chemin que le web push).
    try {
      const reg =
        typeof navigator !== "undefined" && navigator.serviceWorker
          ? await navigator.serviceWorker.getRegistration()
          : null;
      if (reg && typeof reg.showNotification === "function") {
        await reg.showNotification(title, {
          body,
          icon: "/icons/icon-192.png",
          badge: "/icons/badge-72.png",
          // Même tag que le web push (socket.js) : un message déjà notifié par
          // push ET par ce chemin premier-plan se fusionne au lieu de doubler.
          tag: channelId ? `channel:${channelId}` : "murgat-chat",
          renotify: !!channelId,
          data: {
            url: channelId ? `/?channel=${encodeURIComponent(channelId)}` : "/",
            channelId: channelId ?? null,
          },
        });
        return;
      }
    } catch (e) {
      console.warn("[desktop] SW notification failed, fallback in-page:", e?.message || e);
    }
    // Repli : notification non-persistante (aucun SW actif — p. ex. permission
    // accordée mais SW pas encore prêt). Le clic sur le toast vivant navigue en
    // page ; il est perdu depuis le Centre de notifs, mais c'est mieux que rien.
    try {
      const n = new Notification(title, { body });
      n.onclick = () => {
        try {
          window.focus();
        } catch {
          /* certains contextes interdisent focus() — la navigation suit quand même */
        }
        onClick?.();
        n.close();
      };
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

// Desktop (Tauri) only: superpose un simple POINT ROUGE « non lu » sur l'icône de
// la barre des tâches Windows, via un overlay natif (setOverlayIcon) — une
// présence, pas un compteur (même rouge que le point du tray, cohérence + une
// seule image à générer). Pendant desktop du badge PWA. `count <= 0` efface
// l'overlay. No-op hors Tauri ; erreurs avalées (un badge absent ne doit jamais
// casser le traitement des messages). setOverlayIcon est Windows-only — ailleurs
// l'appel est rejeté (capté par le catch), sans conséquence (builds Windows only).
export async function setDesktopBadge(count) {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (!count || count <= 0) {
      await win.setOverlayIcon(undefined); // efface l'overlay
      return;
    }
    const { Image: TauriImage } = await import("@tauri-apps/api/image");
    const { data, width, height } = renderDotRgba();
    // Image.new attend du RGBA brut (pas de décodage → aucune feature Cargo
    // image-png requise), ce que produit exactement le canvas ci-dessous.
    const icon = await TauriImage.new(data, width, height);
    await win.setOverlayIcon(icon);
  } catch (e) {
    console.error("[desktop] setOverlayIcon failed:", e);
  }
}

// Dessine un simple disque rouge (le point « non lu ») sur un canvas et renvoie
// ses octets RGBA bruts. Indépendant du nombre → une seule image, générée à la
// volée. Rendu en 32×32 : Windows le redimensionne vers la taille de l'overlay
// (~16×16, plus grand en haute densité) en gardant un rendu net.
function renderDotRgba() {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = "#E02424"; // même rouge que le point du tray (main.rs)
  ctx.fill();
  // getImageData → RGBA droit (non prémultiplié), l'ordre d'octets attendu.
  const rgba = ctx.getImageData(0, 0, size, size).data;
  return { data: new Uint8Array(rgba.buffer), width: size, height: size };
}

// True when the user is actively looking at the app, so onNotif can skip the OS
// notification + tray badge. Under Tauri, document focus/visibility are stuck at
// "focused/visible" for a tray-hidden window (see presence tracking above), so
// use the real native state — otherwise hidden-to-tray gets NO notification at
// all. Browser/PWA keep the reliable DOM signals.
export function isWindowFocused() {
  if (isTauri()) return desktopVisible && desktopFocused;
  if (typeof document === "undefined") return true;
  try {
    return document.hasFocus() && document.visibilityState !== "hidden";
  } catch {
    return true;
  }
}

// ── Auto-update (Tauri updater plugin, desktop only) ───────────────────────
// Checks the signed GitHub release endpoint (configured in tauri.conf.json).
// Returns the Update object if a newer signed version is available, else null.
// No-op in the browser/PWA (the server-version banner handles those). Never
// throws — a flaky check must not block startup.
export async function checkDesktopUpdate() {
  if (!isTauri()) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    return update && update.available !== false ? update : null;
  } catch (e) {
    console.warn("[updater] check failed:", e?.message || e);
    return null;
  }
}

// Download + install the given update, then relaunch. Throws on failure (e.g. a
// per-machine/Program Files install without admin rights) so the caller can
// surface it to the user.
export async function installDesktopUpdate(update) {
  await update.downloadAndInstall();
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
