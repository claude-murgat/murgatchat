/// <reference lib="webworker" />
// Murgat Chat service worker — push notifications + offline-ready app shell.
//
// Architecture:
//   - Workbox precaches the app shell (manifest injected by vite-plugin-pwa
//     in `injectManifest` mode via `self.__WB_MANIFEST`).
//   - `push` handler is defensive: parses payload as JSON → text → fallback, and
//     always leaves a notification visible (silent push gets the SW deregistered
//     on iOS, Chrome shows a generic one). Nothing shows for a message already
//     alerted here or a conversation on screen in a foreground window. It asks
//     the server whether the message was meanwhile read on another device (push
//     held until unlock by Android Doze) and drops / closes what is already read
//     — see shared/pushTriage.ts — but a push that was just sent never waits for
//     that answer more than an instant.
//   - `notificationclick` focuses an open window or opens a new one, deep-linking
//     to the conversation. Workaround for an iOS WebKit bug where `openWindow`
//     ignores the target URL on a cold app launch: the target URL is also stored
//     in Cache Storage and consumed by the client on next boot (see pwa.js).
//   - `pushsubscriptionchange` re-syncs the new endpoint to the backend.
//
// Patterns proven on iOS 17/18 by the test_pwa reference experiment Charles ran
// in 2026-06 before this PR. See project_pwa-pivot memory + test_pwa/ folder.

import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import type { PrecacheEntry } from "workbox-precaching";
import { isFreshPush, triagePush } from "../../shared/pushTriage.ts";

// Le tsconfig charge à la fois `DOM` et `WebWorker`, si bien que `self` se résout
// vers `Window`. On le redéclare ici (portée module, purement compilatoire) avec
// son vrai type, plus `__WB_MANIFEST` injecté au build par vite-plugin-pwa.
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (PrecacheEntry | string)[];
};

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST || []);

const FALLBACK_TITLE = "Nouveau message";
const FALLBACK_BODY = "Vous avez reçu une notification";

// Où joindre l'API : l'URL est choisie à l'écran de connexion (inconnue au
// build) ; la page la dépose dans ce cache (cf. rememberApiBaseForSw, pwa.ts).
const SW_CONFIG_CACHE = "murgat-sw-config-v1";
const API_BASE_KEY = "/__api_base__";
// Au-delà, on affiche comme avant plutôt que de retarder la notification.
const READ_STATE_TIMEOUT_MS = 2500;
// Un push tout juste envoyé n'attend pas la réponse plus longtemps : au réveil
// d'un téléphone, le réseau met souvent plus d'une seconde à revenir, et c'est
// le délai que l'utilisateur percevait entre la vibration et son message.
const FRESH_READ_WAIT_MS = 300;
// Une fenêtre gelée par l'OS ne répond jamais : on notifie sans elle.
const OPEN_CHANNEL_ANSWER_MS = 200;

// ── Push ──────────────────────────────────────────────────────────────────

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

/** Charge utile envoyée par le serveur : tous les champs sont optionnels. */
interface PushPayload {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
  channelId?: string | null;
  /** Jeton signé : le serveur dit si ce message a été lu depuis (cf. pushReadToken.ts). */
  readToken?: string;
  /** Horodatage (ms) du message : distingue un push récent d'un push retenu en route. */
  sentAt?: number;
  /** Le même message arrive aussi par le socket quand l'app est ouverte. */
  messageId?: string;
}

async function handlePush(event: PushEvent) {
  const payload = parsePayload(event);
  const title = payload.title || FALLBACK_TITLE;
  const data = {
    url: payload.url || "/",
    channelId: payload.channelId || null,
    receivedAt: Date.now(),
    readToken: payload.readToken || null,
    messageId: payload.messageId || null,
  };
  const options = {
    body: payload.body || FALLBACK_BODY,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    // tag: same-tag notifications coalesce on iOS (good for chat per-channel).
    tag: payload.tag || "murgat-chat",
    // Écran verrouillé : la notif doit persister et vibrer, sinon elle peut
    // passer inaperçue / être repliée par l'OS.
    requireInteraction: true,
    vibrate: [200, 100, 200],
    data,
    // Re-vibrate when an existing tagged notification is replaced (Android).
    renotify: !!payload.tag,
  };
  // Message déjà lu ailleurs mais qu'il faut tout de même montrer : ni son ni
  // vibration (Chrome refuse `vibrate` avec `silent`).
  const silentOptions = {
    body: options.body,
    icon: options.icon,
    badge: options.badge,
    tag: options.tag,
    data,
    silent: true,
  };

  // Inform any open window(s) so the in-page badge/sound can react too.
  const informed = informClients(payload);

  if (!payload.readToken || (await isApplePush())) {
    // MANDATORY on iOS: always show a notification, even if the page reacted.
    // Otherwise Safari's WebKit revokes the subscription after a few "silent"
    // pushes. Affichée en premier, sans rien attendre (ni le réseau) ; on efface
    // ensuite, au mieux, les autres notifications devenues caduques.
    await self.registration.showNotification(title, options);
    await closeReadNotifications(payload.readToken);
    await informed;
    return;
  }

  // Le push arrive parfois des heures après l'envoi (Android le retient en Doze
  // jusqu'au déverrouillage) : on demande au serveur ce qui a été lu depuis.
  const displayed = await self.registration.getNotifications();
  // Déjà signalé par le chemin premier plan (socket → notify, desktop.ts) : le
  // même tag remplacerait la notification, et `renotify` alerterait une 2e fois.
  if (payload.messageId && displayed.some((n) => n.data?.messageId === payload.messageId)) {
    await informed;
    return;
  }
  // Conversation sous les yeux, sur CET appareil : rien à signaler, et ce qui
  // restait affiché pour elle n'a plus lieu d'être. Les autres appareils reçoivent
  // leur push normalement, c'est chacun qui décide pour lui-même.
  if (payload.channelId && (await conversationOnScreen(payload.channelId))) {
    for (const n of displayed) if (n.tag === options.tag) n.close();
    await informed;
    return;
  }

  const now = Date.now();
  const pending = fetchReadStates(
    [payload.readToken, ...displayed.map(readTokenOf)],
    typeof payload.sentAt === "number" ? Math.max(0, now - payload.sentAt) : undefined
  );
  const states = isFreshPush(payload.sentAt, now)
    ? await Promise.race([pending, wait(FRESH_READ_WAIT_MS)])
    : await pending;
  if (!states) {
    // Pas de réponse à temps : on affiche maintenant, on trie ensuite. Le tag du
    // message entrant est exclu : l'ancienne notification vient d'être remplacée
    // par la nouvelle, et la fermer fermerait celle-ci.
    await self.registration.showNotification(title, options);
    const late = await pending;
    displayed.forEach((n, i) => {
      if (late[i + 1] === true && n.tag !== options.tag) n.close();
    });
    await informed;
    return;
  }
  const { show, close } = triagePush(
    states[0],
    displayed.map((n, i) => ({ read: states[i + 1], receivedAt: Number(n.data?.receivedAt) || 0 }))
  );
  for (const i of close) displayed[i].close();
  if (show === "normal") await self.registration.showNotification(title, options);
  else if (show === "silent") await self.registration.showNotification(title, silentOptions);
  await informed;
}

async function informClients(payload: PushPayload) {
  try {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) {
      c.postMessage({ type: "PUSH_RECEIVED", payload });
    }
  } catch {
    // Non-fatal.
  }
}

function wait(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

// Une fenêtre au premier plan affiche-t-elle cette conversation ? Seule la page
// le sait (pwa.ts) ; on ne l'interroge que si elle est visible et active, donc
// aucune attente quand le téléphone dort.
async function conversationOnScreen(channelId: string) {
  try {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const foreground = windows.filter((c) => c.focused && c.visibilityState === "visible");
    return (await Promise.all(foreground.map(askOpenChannel))).includes(channelId);
  } catch {
    return false;
  }
}

function askOpenChannel(client: WindowClient): Promise<string | null> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    const timer = setTimeout(() => resolve(null), OPEN_CHANNEL_ANSWER_MS);
    port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(typeof e.data === "string" ? e.data : null);
    };
    client.postMessage({ type: "OPEN_CHANNEL?" }, [port2]);
  });
}

function readTokenOf(n: Notification): string | null {
  return typeof n.data?.readToken === "string" ? n.data.readToken : null;
}

// Ferme les notifications affichées dont le message a été lu depuis (hormis
// celle du push en cours). Best-effort : sans réponse du serveur, rien ne bouge.
async function closeReadNotifications(exceptToken?: string) {
  try {
    const displayed = (await self.registration.getNotifications()).filter((n) => {
      const t = readTokenOf(n);
      return t !== null && t !== exceptToken;
    });
    const states = await fetchReadStates(displayed.map(readTokenOf));
    displayed.forEach((n, i) => {
      if (states[i] === true) n.close();
    });
  } catch {
    // Non-fatal.
  }
}

// Le service push de Safari/iOS exige une notification à chaque push, sans
// délai : sur ses abonnements, on n'attend jamais le réseau avant d'afficher.
let applePush: Promise<boolean> | null = null;
function isApplePush() {
  applePush ??= self.registration.pushManager
    .getSubscription()
    .then((sub) => !!sub && new URL(sub.endpoint).hostname.endsWith(".push.apple.com"))
    // Dans le doute, le chemin prudent (afficher d'abord).
    .catch(() => true);
  return applePush;
}

async function apiBase(): Promise<string | null> {
  try {
    const res = await (await caches.open(SW_CONFIG_CACHE)).match(API_BASE_KEY);
    return res ? (await res.text()).replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

// État de lecture (true = lu) des messages désignés par ces jetons, aligné sur
// `tokens` ; null quand il est inconnu (pas de jeton, API injoignable, délai
// dépassé) — l'appelant se comporte alors comme sans vérification.
// `pushDelayMs` : temps mis par ce push pour arriver, journalisé par le serveur.
async function fetchReadStates(
  tokens: (string | null)[],
  pushDelayMs?: number
): Promise<(boolean | null)[]> {
  const out: (boolean | null)[] = tokens.map(() => null);
  const asked = tokens.flatMap((t, i) => (t ? [i] : []));
  if (asked.length === 0) return out;
  const base = await apiBase();
  if (base === null) return out;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), READ_STATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/auth/web-push/read-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: asked.map((i) => tokens[i]), pushDelayMs }),
      signal: ctrl.signal,
    });
    if (!res.ok) return out;
    const { read } = await res.json();
    if (Array.isArray(read)) {
      asked.forEach((i, k) => {
        out[i] = typeof read[k] === "boolean" ? read[k] : null;
      });
    }
  } catch {
    // Réseau absent ou trop lent : état inconnu.
  } finally {
    clearTimeout(timer);
  }
  return out;
}

function parsePayload(event: PushEvent): PushPayload {
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

async function handleNotificationClick(event: NotificationEvent) {
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

async function storePendingNavigation(url: string) {
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

// ── Web Share Target (#346) ────────────────────────────────────────────────
//
// Quand l'utilisateur partage des photos vers la PWA (feuille de partage de
// l'OS), la plateforme POSTe un multipart/form-data sur l'`action` déclarée au
// manifest (`/share-target`). Une page ne peut pas lire ce corps POST après la
// navigation, donc le SW l'intercepte, met les fichiers de côté dans Cache
// Storage, puis redirige (303 → GET) vers `/?share-target=1`. Au boot, le
// client (pwa.ts) consomme ces fichiers et les attache au Composer.

const SHARE_CACHE = "murgat-shared-v1";

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "POST") return;
  const url = new URL(request.url);
  if (url.pathname !== "/share-target") return;
  event.respondWith(handleShareTarget(request));
});

async function handleShareTarget(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const files = form.getAll("photos").filter((f): f is File => f instanceof File);
    const cache = await caches.open(SHARE_CACHE);
    // Repart d'un cache propre : un partage précédent non consommé ne doit pas
    // se mélanger aux fichiers du nouveau.
    for (const key of await cache.keys()) await cache.delete(key);
    let i = 0;
    for (const file of files) {
      // Une entrée Cache Storage par fichier : le Blob garde son type MIME, et
      // le nom d'origine voyage dans un en-tête (non ré-exposé au réseau).
      await cache.put(
        `/__shared__/${i}`,
        new Response(file, {
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-Shared-Filename": encodeURIComponent(file.name || `photo-${i}`),
          },
        })
      );
      i++;
    }
  } catch (err) {
    // Non bloquant : on redirige quand même pour ouvrir l'app proprement.
    console.warn("[sw] share-target handler failed:", (err as Error)?.message || err);
  }
  // 303 : force la navigation suivante en GET (sinon le navigateur rejouerait le
  // POST). URL absolue : Response.redirect rejette les URL relatives.
  return Response.redirect(new URL("/?share-target=1", self.location.origin).href, 303);
}

// ── Push subscription rotation ────────────────────────────────────────────

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(handleSubscriptionChange(event));
});

async function handleSubscriptionChange(event: PushSubscriptionChangeEvent) {
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
    console.warn("[sw] pushsubscriptionchange handler failed:", (err as Error)?.message || err);
  }
}

// ── Skip waiting on user request ──────────────────────────────────────────

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
