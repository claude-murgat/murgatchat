// Web Push notifications (browser PWA, including iOS Safari ≥16.4 once installed
// via "Add to Home Screen"). Counterpart to push.js (Expo / FCM for native).
//
// VAPID key strategy:
//   1. process.env.VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (preferred for prod)
//   2. vapid.json in /data (Docker volume) — auto-generated on first start
//      and persisted across container restarts so subscriptions don't break.
// VAPID_SUBJECT must be `mailto:` or `https:` per the spec; defaults to mailto.
//
// Subscriptions invalidated by the push service (HTTP 404/410) are pruned from
// the DB on send so they don't pile up forever.
import webpush from "web-push";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "./db.js";

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@murgat-chat.local";
const VAPID_FILE = process.env.VAPID_FILE || path.join(process.cwd(), "data", "vapid.json");

let vapidPublicKey = null;
let vapidPrivateKey = null;
let ready = false;

function loadOrGenerateVapid() {
  // Highest priority: env vars (allows secret rotation without touching disk).
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
    vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
    return { source: "env" };
  }
  // Persisted on disk: stable across restarts so subscriptions don't break.
  try {
    if (fs.existsSync(VAPID_FILE)) {
      const data = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8"));
      if (data?.publicKey && data?.privateKey) {
        vapidPublicKey = data.publicKey;
        vapidPrivateKey = data.privateKey;
        return { source: "file", path: VAPID_FILE };
      }
    }
  } catch (e) {
    console.warn("[webpush] failed to read VAPID_FILE, regenerating:", e.message);
  }
  // First run: generate, persist.
  const keys = webpush.generateVAPIDKeys();
  vapidPublicKey = keys.publicKey;
  vapidPrivateKey = keys.privateKey;
  try {
    fs.mkdirSync(path.dirname(VAPID_FILE), { recursive: true });
    fs.writeFileSync(
      VAPID_FILE,
      JSON.stringify({ publicKey: vapidPublicKey, privateKey: vapidPrivateKey }, null, 2),
      { mode: 0o600 }
    );
    return { source: "generated", path: VAPID_FILE };
  } catch (e) {
    console.error("[webpush] failed to persist VAPID, in-memory only:", e.message);
    return { source: "generated-ephemeral", error: e.message };
  }
}

export function initWebPush() {
  if (ready) return { publicKey: vapidPublicKey };
  const info = loadOrGenerateVapid();
  webpush.setVapidDetails(VAPID_SUBJECT, vapidPublicKey, vapidPrivateKey);
  ready = true;
  console.log(`[webpush] VAPID ${info.source}${info.path ? ` (${info.path})` : ""}`);
  return { publicKey: vapidPublicKey };
}

export function getVapidPublicKey() {
  if (!ready) initWebPush();
  return vapidPublicKey;
}

// Send a push notification to a list of subscriptions. Failed sends with HTTP
// 404 (not found) or 410 (gone) result in the subscription being removed from
// the DB — the user has unsubscribed or the push service has expired the
// endpoint. Other errors are logged but don't prune.
//
// payload is a plain object that will be JSON.stringify'd. Typically:
//   { title, body, url?, tag?, channelId? }
export async function sendWebPush(subscriptions, payload) {
  if (!ready) initWebPush();
  if (!subscriptions?.length) return { sent: 0, pruned: 0 };
  const json = JSON.stringify(payload);
  const toPrune = [];
  let sent = 0;
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        json,
        { TTL: 60 }
      );
      sent++;
    } catch (err) {
      const code = err?.statusCode;
      if (code === 404 || code === 410) {
        // Endpoint dead → remove from DB (don't log every one; can be noisy).
        toPrune.push(sub.endpoint);
      } else {
        console.warn(`[webpush] send failed (${code || "?"}):`, err?.message || err);
      }
    }
  }
  if (toPrune.length) {
    await prisma.webPushSubscription
      .deleteMany({ where: { endpoint: { in: toPrune } } })
      .catch(() => {});
    console.log(`[webpush] pruned ${toPrune.length} dead subscription(s)`);
  }
  return { sent, pruned: toPrune.length };
}
