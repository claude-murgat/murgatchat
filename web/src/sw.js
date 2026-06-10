/// <reference lib="webworker" />
// Murgat Chat service worker — push notifications + offline-ready app shell.
//
// Architecture:
//   - Workbox precaches the app shell (manifest injected by vite-plugin-pwa
//     in `injectManifest` mode via `self.__WB_MANIFEST`).
//   - `push` handler is defensive: always calls showNotification (silent push
//     gets the SW deregistered on iOS), parses payload as JSON → text → fallback.
//   - `notificationclick` focuses an open window or opens a new one, deep-linking
//     to the conversation. Workaround for an iOS WebKit bug where `openWindow`
//     ignores the target URL on a cold app launch: the target URL is also stored
//     in Cache Storage and consumed by the client on next boot (see pwa.js).
//   - `pushsubscriptionchange` re-syncs the new endpoint to the backend.
//
// Patterns proven on iOS 17/18 by the test_pwa reference experiment Charles ran
// in 2026-06 before this PR. See project_pwa-pivot memory + test_pwa/ folder.

import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST || []);

const FALLBACK_TITLE = "Nouveau message";
const FALLBACK_BODY = "Vous avez reçu une notification";

// ── Push ──────────────────────────────────────────────────────────────────

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  const payload = parsePayload(event);
  const title = payload.title || FALLBACK_TITLE;
  const options = {
    body: payload.body || FALLBACK_BODY,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    // tag: same-tag notifications coalesce on iOS (good for chat per-channel).
    tag: payload.tag || "murgat-chat",
    data: {
      url: payload.url || "/",
      channelId: payload.channelId || null,
      receivedAt: Date.now(),
    },
    // Re-vibrate when an existing tagged notification is replaced (Android).
    renotify: !!payload.tag,
  };

  // Inform any open window(s) so the in-page badge/sound can react too.
  try {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) {
      c.postMessage({ type: "PUSH_RECEIVED", payload });
    }
  } catch {
    // Non-fatal.
  }

  // MANDATORY on iOS: always show a notification, even if the page reacted.
  // Otherwise Safari's WebKit revokes the subscription after a few "silent" pushes.
  return self.registration.showNotification(title, options);
}

function parsePayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json();
  } catch {
    // Some servers send plaintext. Fall back to using it as body.
    try {
      return { body: event.data.text() };
    } catch {
      return {};
    }
  }
}

// ── Notification click ────────────────────────────────────────────────────

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event));
});

async function handleNotificationClick(event) {
  const targetUrl = event.notification.data?.url || "/";

  // Store the target URL so we can recover from iOS bug #14430 where
  // openWindow() opens start_url instead of targetUrl on cold app launch.
  // The client reads this from Cache Storage on boot (see pwa.js).
  await storePendingNavigation(targetUrl);

  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

  // Existing tab → focus + tell the SPA to route in-app (no full reload).
  for (const c of clients) {
    if (typeof c.focus === "function") {
      await c.focus();
      c.postMessage({ type: "NAVIGATE", url: targetUrl });
      // If the URL changed (different channel), force-navigate.
      if (c.url && new URL(c.url).pathname + new URL(c.url).search !== targetUrl) {
        if (typeof c.navigate === "function") {
          try {
            await c.navigate(targetUrl);
          } catch {
            // Some browsers reject cross-origin or other edge cases — that's OK,
            // the postMessage above does the soft nav.
          }
        }
      }
      return;
    }
  }

  // No tab open → cold launch.
  if (self.clients.openWindow) {
    await self.clients.openWindow(targetUrl);
  }
}

// ── Pending navigation cache (deep-link recovery) ─────────────────────────

const PENDING_CACHE = "murgat-pending-nav-v1";
const PENDING_KEY = "/__pending_nav__";

async function storePendingNavigation(url) {
  try {
    const cache = await caches.open(PENDING_CACHE);
    await cache.put(
      PENDING_KEY,
      new Response(url, { headers: { "Content-Type": "text/plain" } })
    );
  } catch {
    // Non-fatal: navigation will still happen via postMessage / openWindow.
  }
}

// ── Push subscription rotation ────────────────────────────────────────────

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(handleSubscriptionChange(event));
});

async function handleSubscriptionChange(event) {
  try {
    const oldEndpoint = event.oldSubscription?.endpoint || null;
    const reg = await self.registration;
    // The new subscription may already exist; otherwise re-create from
    // applicationServerKey if we have it cached. We can't fetch a fresh VAPID
    // key from here (no auth context), so the page-level resubscribeIfNeeded()
    // in pwa.js handles the actual re-sync on next open.
    const newSub = event.newSubscription || (await reg.pushManager.getSubscription());
    if (!newSub) return;

    // Tell any open tab so it forwards to the backend with credentials.
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) {
      c.postMessage({
        type: "PUSH_SUBSCRIPTION_CHANGED",
        endpoint: newSub.endpoint,
        oldEndpoint,
      });
    }
  } catch (err) {
    // Best-effort; the page-level reconcile on next open will catch us up.
    console.warn("[sw] pushsubscriptionchange handler failed:", err?.message || err);
  }
}

// ── Skip waiting on user request ──────────────────────────────────────────

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
