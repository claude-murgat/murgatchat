// Client-side PWA orchestration: service worker registration, push subscription,
// deep-link recovery, install prompt handling.
//
// Lifecycle:
//   1. On login (App.jsx calls ensurePwaReady()), register /sw.js.
//   2. If Notification.permission is granted, subscribe and sync to the backend.
//      If 'default', show a UI affordance (not requested here — the caller
//      decides when to ask, e.g. from a "Notifications" toggle in preferences).
//   3. On each app boot, consumePendingNavigation() reads the URL the SW stored
//      from a notificationclick before the app was opened (works around iOS
//      WebKit's openWindow ignoring the target URL on cold launch).
//   4. Listen for messages from the SW: PUSH_RECEIVED, NAVIGATE,
//      PUSH_SUBSCRIPTION_CHANGED.
//
// All API calls go through api.js so they respect the runtime-configured server URL.

import { api, getApiBaseUrl, getToken } from "./api.js";

const PENDING_CACHE = "murgat-pending-nav-v1";
const PENDING_KEY = "/__pending_nav__";

let swRegistration = null;
let lastVapidKey = null;

// ── Public API ────────────────────────────────────────────────────────────

// Detect PWA install state (iOS Safari uses navigator.standalone; everyone
// else uses display-mode media query).
export function isPwaInstalled() {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  if (window.navigator?.standalone === true) return true;
  return false;
}

export function pwaSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

// One-shot bootstrap, called after login. Idempotent.
export async function ensurePwaReady() {
  if (!pwaSupported()) return { supported: false };
  try {
    const reg = await registerServiceWorker();
    swRegistration = reg;

    // Wire SW messages → window events (so React components can react to deep
    // links and live push payloads without polling).
    listenForSwMessages();

    // If the user has already granted permission in a previous visit,
    // resubscribe silently (handles VAPID rotation, browser-side expiry).
    if (Notification.permission === "granted") {
      await ensureSubscribed();
    }

    // Consume any pending deep-link the SW stored before this load. Dispatched
    // as a window event so the React tree can route to it.
    const pending = await consumePendingNavigation();
    if (pending) {
      window.dispatchEvent(new CustomEvent("pwa:deeplink", { detail: { url: pending } }));
    }
    return { supported: true, registration: reg };
  } catch (e) {
    console.warn("[pwa] init failed:", e?.message || e);
    return { supported: true, error: e?.message || String(e) };
  }
}

// Triggered by an explicit UI control (button in preferences, banner, etc.).
// Walks through requesting permission + subscribing + syncing to the backend.
// Returns { ok: true } on success, { ok: false, reason } on failure.
export async function requestNotificationPermission() {
  if (!pwaSupported()) return { ok: false, reason: "unsupported" };
  if (Notification.permission === "denied") {
    return { ok: false, reason: "denied" };
  }
  if (Notification.permission !== "granted") {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, reason: perm };
  }
  // Permission OK → ensure SW + subscribe.
  if (!swRegistration) {
    swRegistration = await registerServiceWorker();
  }
  const sub = await ensureSubscribed();
  if (!sub) return { ok: false, reason: "subscribe_failed" };
  return { ok: true };
}

// Called from a logout flow: unsubscribe locally + tell the backend so we stop
// receiving pushes for this device.
export async function unsubscribePush() {
  try {
    if (!swRegistration) {
      swRegistration = await navigator.serviceWorker.getRegistration();
    }
    if (!swRegistration) return;
    const sub = await swRegistration.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    // Best-effort: tell the backend (may fail if logged out already — OK).
    try {
      if (getToken()) {
        await api.webPushUnsubscribe(endpoint);
      }
    } catch {
      // Non-fatal.
    }
  } catch (e) {
    console.warn("[pwa] unsubscribe failed:", e?.message || e);
  }
}

// ── Internals ─────────────────────────────────────────────────────────────

async function registerServiceWorker() {
  // Vite's PWA plugin emits /sw.js at the site root. type:'module' isn't
  // strictly needed because we use injectManifest with a non-module build,
  // but keep classic for the widest iOS support.
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  // Wait until it's controlling the page (otherwise the first install may
  // race with the subscribe call below).
  if (!reg.active && reg.installing) {
    await new Promise((resolve) => {
      const sw = reg.installing;
      sw.addEventListener("statechange", () => {
        if (sw.state === "activated") resolve();
      });
    });
  }
  return reg;
}

async function ensureSubscribed() {
  if (!swRegistration) return null;
  let sub = await swRegistration.pushManager.getSubscription();
  if (!sub) {
    const vapidKey = await fetchVapidKey();
    if (!vapidKey) return null;
    try {
      sub = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    } catch (e) {
      console.warn("[pwa] subscribe failed:", e?.message || e);
      return null;
    }
  }
  await syncSubscriptionToBackend(sub);
  return sub;
}

async function fetchVapidKey() {
  if (lastVapidKey) return lastVapidKey;
  try {
    const base = getApiBaseUrl();
    if (!base) return null;
    const res = await fetch(`${base}/auth/web-push/vapid-public-key`);
    if (!res.ok) return null;
    const data = await res.json();
    lastVapidKey = data?.publicKey || null;
    return lastVapidKey;
  } catch (e) {
    console.warn("[pwa] vapid fetch failed:", e?.message || e);
    return null;
  }
}

async function syncSubscriptionToBackend(sub, oldEndpoint = null) {
  if (!sub) return;
  const raw = sub.toJSON ? sub.toJSON() : null;
  const keys = raw?.keys || {};
  const endpoint = sub.endpoint;
  if (!endpoint || !keys.p256dh || !keys.auth) return;
  try {
    await api.webPushSubscribe({
      endpoint,
      keys,
      userAgent: navigator.userAgent,
      oldEndpoint,
    });
  } catch (e) {
    console.warn("[pwa] backend subscribe sync failed:", e?.message || e);
  }
}

function listenForSwMessages() {
  if (!navigator.serviceWorker || listenForSwMessages._bound) return;
  listenForSwMessages._bound = true;
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data;
    if (!data?.type) return;
    if (data.type === "NAVIGATE" && data.url) {
      window.dispatchEvent(new CustomEvent("pwa:deeplink", { detail: { url: data.url } }));
    } else if (data.type === "PUSH_RECEIVED") {
      window.dispatchEvent(new CustomEvent("pwa:push", { detail: data.payload || {} }));
    } else if (data.type === "PUSH_SUBSCRIPTION_CHANGED" && data.endpoint) {
      // The SW lost the old subscription; resubscribe + sync.
      ensureSubscribed().catch(() => {});
    }
  });
}

async function consumePendingNavigation() {
  try {
    const cache = await caches.open(PENDING_CACHE);
    const res = await cache.match(PENDING_KEY);
    if (!res) return null;
    const url = await res.text();
    await cache.delete(PENDING_KEY);
    return url;
  } catch {
    return null;
  }
}

// VAPID key (URL-safe base64) → Uint8Array per Web Push spec.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
