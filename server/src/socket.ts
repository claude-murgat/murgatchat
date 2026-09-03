import { Server } from "socket.io";
import type { Server as HttpServer } from "node:http";
import type { User } from "@prisma/client";
import { verifyToken } from "./auth.ts";
import { prisma } from "./db.ts";
import { serializeMessage } from "./routes/channels.ts";
import { encryptBody } from "./crypto.ts";
import { sendExpoPush } from "./push.ts";
import { sendWebPush } from "./webpush.ts";
import { NotificationEventSchema } from "../../shared/contracts.ts";
import { checkContract } from "./contractCheck.ts";
import { claudeExpertEnabled, dispatchExpertTurn } from "./claudeHelper.ts";

// Sous-ensemble des colonnes `User` que le calcul DnD lit vraiment. En
// production l'appelant passe une ligne Prisma complète, mais les tests
// unitaires lui passent un objet partiel (`{}`, `{ dndUntil }`…) : le `Partial`
// décrit ce contrat tolérant sans dupliquer les types de colonnes.
type DndUser = Partial<
  Pick<User, "dndUntil" | "dndScheduleEnabled" | "dndStart" | "dndEnd">
>;

// DnD actif si fenêtre ponctuelle (dndUntil) OU plage quotidienne (heure serveur)
export function isUserDnd(user: DndUser, now = new Date()) {
  if (user.dndUntil && user.dndUntil > now) return true;
  if (user.dndScheduleEnabled && user.dndStart && user.dndEnd) {
    const cur = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = user.dndStart.split(":").map(Number);
    const [eh, em] = user.dndEnd.split(":").map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (start === end) return false;
    return start < end ? cur >= start && cur < end : cur >= start || cur < end;
  }
  return false;
}

// A visible client sends an "activity" heartbeat every 60s, so a socket that
// hasn't checked in within this window is no longer in the foreground. Kept at
// ~2.5 min (tolerates one dropped heartbeat) rather than 10 min: the explicit
// "away" signal a PWA emits on background isn't reliable (the OS can suspend the
// JS before it flushes), so this fallback is what actually resumes pushes for a
// just-backgrounded phone — at 10 min, users lost notifications for up to 10 min
// after closing the app. Server-side, so it applies to existing clients too.
const AWAY_AFTER_MS = 150 * 1000;
// userId -> Map(socketId -> last activity ms), web/desktop clients only. The
// client also signals "away" the instant the page is hidden (fast path), and a
// disconnect removes the socket too. Per-socket so one focused device doesn't
// suppress pushes meant for another (a desktop in front shouldn't mute the phone).
const webActivity = new Map<string, Map<string, number>>();

function markWebActivity(userId: string, socketId: string) {
  let sockets = webActivity.get(userId);
  if (!sockets) {
    sockets = new Map();
    webActivity.set(userId, sockets);
  }
  sockets.set(socketId, Date.now());
}
function markWebInactive(userId: string, socketId: string) {
  const sockets = webActivity.get(userId);
  if (!sockets) return;
  sockets.delete(socketId);
  if (sockets.size === 0) webActivity.delete(userId);
}
// True when the user has no visible/recent web/desktop socket — i.e. away from
// their computer, so a push is warranted.
function webDesktopInactive(userId: string) {
  const sockets = webActivity.get(userId);
  if (!sockets || sockets.size === 0) return true;
  const now = Date.now();
  for (const ts of sockets.values()) {
    if (now - ts <= AWAY_AFTER_MS) return false;
  }
  return true;
}

// Les seuls champs utilisateur consultés pour la détection de mention ; `Partial`
// pour la même raison que `DndUser` (appels de test avec un objet partiel).
type MentionUser = Partial<Pick<User, "username" | "displayName">>;

// Le membre est-il mentionné dans `body` ? Faute de système d'autocomplétion de
// mentions, on reconnaît un simple "@pseudo" (username ou displayName), insensible
// à la casse. Sert au niveau de notification "mentions" par channel.
export function isMentioned(user: MentionUser, body: unknown) {
  if (!body) return false;
  const text = String(body).toLowerCase();
  return [user.username, user.displayName]
    .filter(Boolean)
    .some((handle) => text.includes("@" + String(handle).toLowerCase()));
}

// Ce que `notifyMembers` lit du message sérialisé (`serializeMessage`, contrat
// `MessageSchema` de shared/contracts.ts) : le reste du payload est relayé tel
// quel dans l'évènement socket, donc inutile de le décrire ici. `author` peut se
// réduire à `{ id }` quand la relation n'a pas été chargée (cf. publicUser).
type NotifiableMessage = {
  body: string | null;
  author?: { id: string; displayName?: string | null } | null;
};

// Notify channel members (except author) who aren't in DnD: in-app "notification"
// event, plus a push (Expo for native, Web Push for browser PWAs) for those
// whose web/desktop has been idle >= 10 min. Web push is the iOS distribution
// channel since the PWA pivot (no TestFlight build).
//
// Chaque membre choisit son niveau par channel (Membership.notifyLevel) : "none"
// coupe toute notification (le badge non-lu reste, façon Slack/Discord), "mentions"
// ne notifie que s'il est cité, "all" notifie tout. DnD reste prioritaire et
// suppressif par-dessus.
export async function notifyMembers(
  io: Server,
  channelId: string,
  authorId: string,
  serialized: NotifiableMessage
) {
  const members = await prisma.membership.findMany({
    where: { channelId },
    include: { user: true },
  });
  const awayUserIds: string[] = [];
  // Frontière serveur : on valide le payload de notification contre le contrat
  // partagé (non bloquant), une seule fois — il est identique pour tous les membres.
  const notifPayload = { channelId, message: serialized };
  checkContract(NotificationEventSchema, notifPayload, "emit notification");
  for (const cm of members) {
    if (cm.userId === authorId) continue;
    if (cm.notifyLevel === "none") continue;
    if (cm.notifyLevel === "mentions" && !isMentioned(cm.user, serialized.body)) continue;
    if (isUserDnd(cm.user)) continue;
    io.to(`user:${cm.userId}`).emit("notification", notifPayload);
    if (webDesktopInactive(cm.userId)) awayUserIds.push(cm.userId);
  }
  if (awayUserIds.length === 0) return;
  const title = serialized.author?.displayName || "Nouveau message";
  const body = serialized.body || "(pièce jointe)";

  const [tokens, webSubs] = await Promise.all([
    prisma.pushToken.findMany({ where: { userId: { in: awayUserIds } } }),
    prisma.webPushSubscription.findMany({ where: { userId: { in: awayUserIds } } }),
  ]);
  if (tokens.length === 0 && webSubs.length === 0) {
    console.log(
      "[push] away (web/desktop idle) but no device/web subscription:",
      awayUserIds.join(",")
    );
    return;
  }
  console.log(
    `[push] notifying ${tokens.length} native + ${webSubs.length} web for ${awayUserIds.length} away user(s)`
  );
  // Native pushes (Expo / FCM) for Android (and historically iOS).
  if (tokens.length) {
    await sendExpoPush(
      tokens.map((t) => ({ to: t.token, title, body, sound: "default", data: { channelId } }))
    );
  }
  // Web pushes (browser / installed PWA, including iOS Safari Add to Home Screen).
  // `url` lets the service worker focus / deep-link to the right conversation.
  if (webSubs.length) {
    await sendWebPush(webSubs, {
      title,
      body,
      url: `/?channel=${encodeURIComponent(channelId)}`,
      channelId,
      // Unique tag per channel: iOS coalesces same-tag notifications so the
      // dock badge stays accurate but the user only sees the most recent banner.
      tag: `channel:${channelId}`,
    });
  }
}

export function setupSocket(httpServer: HttpServer, corsOrigin?: string) {
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin || "*", credentials: false },
  });

  // userId -> number of active sockets (a user can have several tabs/devices)
  const online = new Map<string, number>();

  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer /, "");
    const payload = token ? verifyToken(token) : null;
    if (!payload) return next(new Error("unauthorized"));
    socket.data.userId = payload.sub;
    socket.data.platform = socket.handshake.auth?.platform || "web";
    next();
  });

  io.on("connection", async (socket) => {
    const userId = socket.data.userId;
    socket.join(`user:${userId}`);

    const memberships = await prisma.membership.findMany({ where: { userId } });
    for (const m of memberships) socket.join(`channel:${m.channelId}`);

    const prevCount = online.get(userId) || 0;
    online.set(userId, prevCount + 1);
    if (prevCount === 0) io.emit("presence:update", { userId, online: true });
    socket.emit("presence:state", { userIds: [...online.keys()] });

    if (socket.data.platform !== "mobile") markWebActivity(userId, socket.id);
    socket.on("activity", () => {
      if (socket.data.platform !== "mobile") markWebActivity(userId, socket.id);
    });
    // Page hidden / backgrounded -> drop this socket so push resumes right away
    // (no 10-min wait). Becoming visible/focused again re-emits "activity".
    socket.on("away", () => {
      if (socket.data.platform !== "mobile") markWebInactive(userId, socket.id);
    });

    socket.on("channel:join", (channelId) => {
      socket.join(`channel:${channelId}`);
    });

    socket.on("typing", ({ channelId } = {}) => {
      if (!channelId) return;
      socket.to(`channel:${channelId}`).emit("typing:update", { channelId, userId });
    });

    socket.on("message:send", async (payload, ack) => {
      try {
        const { channelId, body, scheduledAt, attachmentIds = [], parentId } =
          payload || {};
        // Defensive: a buggy client could send [undefined]/garbage, and Prisma
        // throws on a non-string inside a `where id in […]` filter — which
        // surfaced as a 500 → "server_error" (e.g. a GIF send passing the wrong
        // id). Keep only non-empty string ids.
        const ids = (Array.isArray(attachmentIds) ? attachmentIds : []).filter(
          (x) => typeof x === "string" && x.length > 0
        );
        const trimmed = (body || "").trim();
        if (!channelId || (!trimmed && ids.length === 0)) {
          return ack?.({ error: "invalid_payload" });
        }
        const member = await prisma.membership.findUnique({
          where: { userId_channelId: { userId, channelId } },
          // kind du canal : détecter les conversations de l'expert Claude sans
          // requête supplémentaire (voir le hook après notifyMembers).
          include: { channel: { select: { kind: true } } },
        });
        if (!member) return ack?.({ error: "not_a_member" });

        if (parentId) {
          const parent = await prisma.message.findUnique({ where: { id: parentId } });
          // Discord/Messenger model: you can reply to ANY delivered message in
          // the channel, including another reply. The quote stays one level deep
          // (we only render the cited message, never its own parent), so there's
          // no nesting — `parent.parentId` is allowed (was rejected under the old
          // Slack-thread model).
          if (!parent || parent.channelId !== channelId || !parent.delivered) {
            return ack?.({ error: "invalid_parent" });
          }
        }

        if (ids.length) {
          const valid = await prisma.attachment.findMany({
            where: {
              id: { in: ids },
              uploadedBy: userId,
              messageId: null,
            },
            select: { id: true },
          });
          if (valid.length !== ids.length) {
            return ack?.({ error: "invalid_attachments" });
          }
        }

        const scheduledDate = scheduledAt ? new Date(scheduledAt) : null;
        const isScheduled =
          !parentId && scheduledDate && scheduledDate.getTime() > Date.now() + 1000;

        const msg = await prisma.message.create({
          data: {
            channelId,
            authorId: userId,
            body: encryptBody(trimmed),
            // Plaintext copy for the Postgres full-text index (see schema note).
            searchableBody: trimmed,
            parentId: parentId || null,
            scheduledAt: isScheduled ? scheduledDate : null,
            delivered: !isScheduled,
          },
          include: {
            author: true,
            attachments: true,
            // Hydrate the parent for the inline quote in the recipient's UI.
            parent: { include: { author: true } },
          },
        });

        if (ids.length) {
          await prisma.attachment.updateMany({
            where: { id: { in: ids } },
            data: { messageId: msg.id },
          });
          msg.attachments = await prisma.attachment.findMany({
            where: { messageId: msg.id },
          });
        }

        if (isScheduled) {
          ack?.({ ok: true, scheduled: serializeMessage(msg) });
          return;
        }

        // Discord/Messenger model: replies share the timeline with root
        // messages, so we always emit `message:new` and let the client
        // render the inline quote bubble from `serialized.parent`.
        const serialized = serializeMessage(msg);
        io.to(`channel:${channelId}`).emit("message:new", serialized);

        await notifyMembers(io, channelId, userId, serialized);
        ack?.({ ok: true, message: serialized });

        // Conversation avec l'expert Claude : déclencher un tour d'analyse sur
        // la VM auxiliaire. Fire-and-forget APRÈS l'ack — un pont en panne ne
        // doit ni retarder ni casser l'envoi (dispatchExpertTurn n'émet jamais
        // d'exception : il poste un message d'erreur du bot à la place).
        if (member.channel.kind === "claude" && claudeExpertEnabled()) {
          const authorName = msg.author?.displayName ?? null;
          void dispatchExpertTurn(io, channelId, trimmed, { displayName: authorName });
        }
      } catch (err) {
        console.error("message:send", err);
        ack?.({ error: "server_error" });
      }
    });

    socket.on("channel:read", async ({ channelId }) => {
      if (!channelId) return;
      await prisma.membership
        .update({
          where: { userId_channelId: { userId, channelId } },
          data: { lastReadAt: new Date() },
        })
        .catch(() => {});
      // Sync the read state to the user's OTHER devices/tabs so their unread
      // badge clears too (the sender already cleared locally).
      socket.to(`user:${userId}`).emit("channel:read", { channelId });
    });

    socket.on("channel:unread", async ({ channelId }) => {
      if (!channelId) return;
      // Marquer comme non lu : on recule `lastReadAt` juste avant le dernier
      // message livré du salon, pour que serializeChannel le recalcule en
      // "non lu" (voir la logique `unread` dans routes/channels.js).
      const last = await prisma.message
        .findFirst({
          where: { channelId, delivered: true },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        })
        .catch(() => null);
      if (!last) return;
      // 1 s de marge avant l'horodatage du message : le comparateur d'unread
      // est strict (`>`), une marge évite les faux négatifs de précision.
      const before = new Date(new Date(last.createdAt).getTime() - 1000);
      await prisma.membership
        .update({
          where: { userId_channelId: { userId, channelId } },
          data: { lastReadAt: before },
        })
        .catch(() => {});
      // Propage aux autres appareils/onglets de l'utilisateur.
      socket.to(`user:${userId}`).emit("channel:unread", { channelId });
    });

    socket.on("disconnect", () => {
      markWebInactive(userId, socket.id);
      const count = (online.get(userId) || 1) - 1;
      if (count <= 0) {
        online.delete(userId);
        io.emit("presence:update", { userId, online: false });
      } else {
        online.set(userId, count);
      }
    });
  });

  return io;
}

export async function dispatchScheduledMessages(io: Server) {
  const now = new Date();
  const due = await prisma.message.findMany({
    where: { delivered: false, scheduledAt: { lte: now } },
    include: { author: true, channel: { select: { kind: true } } },
    take: 50,
  });
  for (const msg of due) {
    const updated = await prisma.message.update({
      where: { id: msg.id },
      // `scheduledAt` est non-null par construction ici : le `where` ci-dessus ne
      // remonte que les messages dont `scheduledAt <= now`, ce que le type Prisma
      // (`Date | null`) ne peut pas exprimer — d'où l'assertion.
      data: { delivered: true, createdAt: msg.scheduledAt! },
      include: { author: true, attachments: true },
    });
    const serialized = serializeMessage(updated);
    io.to(`channel:${msg.channelId}`).emit("message:new", serialized);

    await notifyMembers(io, msg.channelId, msg.authorId, serialized);

    // Un message programmé dans la conversation de l'expert déclenche le tour
    // à la livraison — même chemin que message:send.
    if (msg.channel.kind === "claude" && claudeExpertEnabled()) {
      void dispatchExpertTurn(io, msg.channelId, updated.searchableBody || "", {
        displayName: msg.author?.displayName ?? null,
      });
    }
  }
}
