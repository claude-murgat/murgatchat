import { Server } from "socket.io";
import type { Socket } from "socket.io";
import type { Server as HttpServer } from "node:http";
import type { User } from "@prisma/client";
import { authenticate } from "./auth.ts";
import { prisma } from "./db.ts";
import { serializeMessage, isMember } from "./routes/channels.ts";
import { safeUnlink } from "./storage.ts";
import { encryptBody } from "./crypto.ts";
import { sendExpoPush } from "./push.ts";
import { sendWebPush } from "./webpush.ts";
import { signReadToken } from "./pushReadToken.ts";
import { NotificationEventSchema } from "../../shared/contracts.ts";
import { checkContract } from "./contractCheck.ts";
import { claudeExpertEnabled, dispatchExpertTurn } from "./claudeHelper.ts";
import { DEFAULT_EXPERT } from "./experts.ts";

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

// Notifications push : on pousse vers TOUS les appareils de l'utilisateur dès
// qu'un message le concerne, sans tenir compte de la présence. L'ancien système
// (heartbeat "activity"/"away" + sonde "presence:probe") retenait le push de
// l'appareil regardé ; il a été retiré à la demande (on préfère notifier partout,
// quitte à doubler l'affichage in-app sur l'appareil actif).

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
  // Horodatage du message : signé dans le jeton de lecture des Web Push.
  createdAt?: string | Date | null;
};

// Notify channel members (except author) who aren't in DnD: in-app "notification"
// event, plus a push (Expo for native, Web Push for browser PWAs) to every one of
// their devices. Web push is the iOS distribution channel since the PWA pivot (no
// TestFlight build).
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
  const recipientIds: string[] = [];
  // Frontière serveur : on valide le payload de notification contre le contrat
  // partagé (non bloquant), une seule fois — il est identique pour tous les membres.
  const notifPayload = { channelId, message: serialized };
  checkContract(NotificationEventSchema, notifPayload, "emit notification");
  for (const cm of members) {
    if (cm.userId === authorId) continue;
    // Compte désactivé : il reste membre (réactivable) mais ne reçoit plus rien —
    // un push porterait encore l'extrait du message jusqu'à son téléphone.
    if (cm.user.status === "disabled") continue;
    if (cm.notifyLevel === "none") continue;
    if (cm.notifyLevel === "mentions" && !isMentioned(cm.user, serialized.body)) continue;
    if (isUserDnd(cm.user)) continue;
    io.to(`user:${cm.userId}`).emit("notification", notifPayload);
    recipientIds.push(cm.userId);
  }
  const push: PushContent = {
    channelId,
    title: serialized.author?.displayName || "Nouveau message",
    body: pushExcerpt(serialized.body || "(pièce jointe)"),
    sentAt: serialized.createdAt ? new Date(serialized.createdAt).getTime() : Date.now(),
  };
  await pushToUsers(recipientIds, push);
}

// `sentAt` : horodatage (ms) du message, comparé à `lastReadAt` (cf. pushReadToken.ts).
type PushContent = { channelId: string; title: string; body: string; sentAt: number };

// Les services push refusent une charge utile de plus de 4 Ko (FCM répond 413,
// APNs pareil, Expo renvoie MessageTooBig) : le destinataire ne recevrait rien.
// Le push ne porte donc qu'un extrait du message, borné en caractères pour
// l'affichage et en octets pour la taille : en UTF-8, une fois échappé par
// JSON.stringify, un émoji pèse 4 octets et un caractère de contrôle 6.
const PUSH_BODY_MAX_CHARS = 500;
const PUSH_BODY_MAX_BYTES = 2000;
const ELLIPSIS = "…";

// Octets qu'occupe `s` dans le JSON de la charge utile, guillemets exclus.
function jsonByteLength(s: string) {
  return Buffer.byteLength(JSON.stringify(s)) - 2;
}

// Le texte tel quel s'il tient dans les deux bornes, sinon son début suivi de
// « … ». Découpe par point de code (Array.from) : jamais une paire de
// substitution coupée en deux, qu'un service push afficherait comme �.
export function pushExcerpt(text: string) {
  const chars = Array.from(text);
  if (chars.length <= PUSH_BODY_MAX_CHARS && jsonByteLength(text) <= PUSH_BODY_MAX_BYTES) {
    return text;
  }
  let excerpt = "";
  let bytes = jsonByteLength(ELLIPSIS);
  for (const ch of chars.slice(0, PUSH_BODY_MAX_CHARS - 1)) {
    bytes += jsonByteLength(ch);
    if (bytes > PUSH_BODY_MAX_BYTES) break;
    excerpt += ch;
  }
  return excerpt.trimEnd() + ELLIPSIS;
}

// Push vers tous les appareils (natifs et navigateurs) des utilisateurs donnés.
async function pushToUsers(userIds: string[], { channelId, title, body, sentAt }: PushContent) {
  if (userIds.length === 0) return;
  const [tokens, webSubs] = await Promise.all([
    prisma.pushToken.findMany({ where: { userId: { in: userIds } } }),
    prisma.webPushSubscription.findMany({ where: { userId: { in: userIds } } }),
  ]);
  if (tokens.length === 0 && webSubs.length === 0) {
    console.log("[push] no device/web subscription for:", userIds.join(","));
    return;
  }
  console.log(
    `[push] notifying ${tokens.length} native + ${webSubs.length} web for ${userIds.length} user(s)`
  );
  // Natif et web partent en parallèle : l'un n'attend pas l'aller-retour de l'autre.
  const sends: Promise<unknown>[] = [];
  // Native pushes (Expo / FCM) for Android (and historically iOS).
  // priority:high + channelId:default => heads-up + verrouillé (sinon
  // Android les retient jusqu'au déverrouillage en Doze).
  if (tokens.length) {
    sends.push(
      sendExpoPush(
        tokens.map((t) => ({
          to: t.token,
          title,
          body,
          sound: "default",
          priority: "high" as const,
          channelId: "default",
          data: { channelId },
        }))
      )
    );
  }
  // Web pushes (browser / installed PWA, including iOS Safari Add to Home Screen).
  // `url` lets the service worker focus / deep-link to the right conversation.
  // Une charge par destinataire : le jeton de lecture lui est propre.
  const subsByUser = new Map<string, typeof webSubs>();
  for (const sub of webSubs) {
    subsByUser.set(sub.userId, [...(subsByUser.get(sub.userId) ?? []), sub]);
  }
  for (const [userId, subs] of subsByUser) {
    sends.push(
      sendWebPush(subs, {
        title,
        body,
        url: `/?channel=${encodeURIComponent(channelId)}`,
        channelId,
        // Unique tag per channel: iOS coalesces same-tag notifications so the
        // dock badge stays accurate but the user only sees the most recent banner.
        tag: `channel:${channelId}`,
        // Permet au service worker de vérifier, à l'affichage, que le message
        // n'a pas été lu entre-temps sur un autre appareil (cf. sw.ts).
        readToken: signReadToken({ userId, channelId, createdAt: sentAt }),
      })
    );
  }
  await Promise.all(sends);
}

// Ferme sur-le-champ les sessions temps réel d'un compte désactivé ou supprimé.
// Son JWT reste valide jusqu'à expiration : c'est la relecture du statut à
// chaque accès (authenticate) qui le neutralise, ceci ne fait que couper ce qui
// est déjà ouvert. `session:revoked` part avant la coupure (les paquets sont
// émis dans l'ordre, le transport n'est fermé qu'une fois vidé) : le client
// revient à l'écran de connexion au lieu de rester affiché, hors ligne.
export function revokeUserSessions(
  io: Server,
  userId: string,
  reason: "disabled" | "deleted"
) {
  io.to(`user:${userId}`).emit("session:revoked", { reason });
  io.in(`user:${userId}`).disconnectSockets(true);
}

// Une room `channel:<id>` reçoit TOUT le trafic d'un salon (messages, réactions,
// saisie, liste des membres) : seuls ses membres y entrent. Après chaque entrée,
// les appartenances sont relues et la socket ressort des rooms qu'un retrait
// concurrent (membership supprimée, PUIS socketsLeave) a vidées entre la lecture
// et le join — sans quoi elle y resterait abonnée jusqu'à sa reconnexion.
async function recheckRooms(socket: Socket, userId: string, channelIds: string[]) {
  try {
    const rows = await prisma.membership.findMany({
      where: { userId, channelId: { in: channelIds } },
      select: { channelId: true },
    });
    const still = new Set(rows.map((m) => m.channelId));
    for (const id of channelIds) if (!still.has(id)) socket.leave(`channel:${id}`);
  } catch (e) {
    console.error("[socket] recheckRooms:", e instanceof Error ? e.message : e);
  }
}

export function setupSocket(httpServer: HttpServer, corsOrigin?: string) {
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin || "*", credentials: false },
  });

  // userId -> number of active sockets (a user can have several tabs/devices)
  const online = new Map<string, number>();

  io.use(async (socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer /, "");
    // Même contrôle que requireAuth : un compte désactivé ou supprimé est refusé
    // malgré un JWT encore valide (les clients se déconnectent sur
    // « unauthorized »). Une base injoignable n'est PAS un refus : erreur
    // distincte, pour qu'aucun client ne ferme sa session sur un incident passager.
    let user;
    try {
      user = await authenticate(token);
    } catch (e) {
      console.error("[socket] handshake:", e instanceof Error ? e.message : e);
      return next(new Error("server_error"));
    }
    if (!user) return next(new Error("unauthorized"));
    socket.data.userId = user.id;
    socket.data.platform = socket.handshake.auth?.platform || "web";
    next();
  });

  io.on("connection", async (socket) => {
    const userId = socket.data.userId;
    socket.join(`user:${userId}`);

    // Statut relu APRÈS l'entrée dans la room `user:` : un compte désactivé
    // entre la poignée de main et cette ligne a échappé à revokeUserSessions
    // (qui vise la room) — il est rattrapé ici, avant de rejoindre un salon.
    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, memberships: { select: { channelId: true } } },
    });
    if (!me || me.status === "disabled") {
      revokeUserSessions(io, userId, me ? "disabled" : "deleted");
      return;
    }
    const channelIds = me.memberships.map((m) => m.channelId);
    for (const id of channelIds) socket.join(`channel:${id}`);
    // Sans attendre : les écouteurs ci-dessous doivent être posés au plus tôt.
    void recheckRooms(socket, userId, channelIds);

    const prevCount = online.get(userId) || 0;
    online.set(userId, prevCount + 1);
    if (prevCount === 0) io.emit("presence:update", { userId, online: true });
    socket.emit("presence:state", { userIds: [...online.keys()] });

    // Le client redemande la room du salon qu'il ouvre. Sans contrôle, n'importe
    // quel compte connecté s'abonnait à un salon privé ou à un DM dont il
    // connaissait l'id, et en recevait tout le trafic.
    socket.on("channel:join", async (channelId) => {
      if (typeof channelId !== "string" || !channelId) return;
      try {
        if (!(await isMember(userId, channelId))) return;
      } catch (e) {
        console.error("[socket] channel:join:", e instanceof Error ? e.message : e);
        return;
      }
      socket.join(`channel:${channelId}`);
      await recheckRooms(socket, userId, [channelId]);
    });

    socket.on("typing", ({ channelId } = {}) => {
      if (!channelId) return;
      // Rooms = salons dont l'utilisateur est membre (voir recheckRooms) :
      // personne d'autre n'affiche « … est en train d'écrire » dans un salon privé.
      if (!socket.rooms.has(`channel:${channelId}`)) return;
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
          include: { channel: { select: { kind: true, expert: true } } },
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
          void dispatchExpertTurn(
            io,
            channelId,
            trimmed,
            { displayName: authorName },
            member.channel.expert || DEFAULT_EXPERT
          );
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
      // message livré du salon (hors messages qu'il a masqués), pour que
      // serializeChannel le recalcule en "non lu" (voir la logique `unread`
      // dans routes/channels.js).
      const last = await prisma.message
        .findFirst({
          where: { channelId, delivered: true, hiddenBy: { none: { userId } } },
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
    // Un compte désactivé n'envoie plus rien, pas même ce qu'il avait programmé :
    // ses messages restent en attente (ils partiront s'il est réactivé). Filtré
    // dans la requête, et non sauté dans la boucle, pour ne pas boucher la file.
    where: { delivered: false, scheduledAt: { lte: now }, author: { status: { not: "disabled" } } },
    include: {
      author: true,
      attachments: { select: { storagePath: true } },
      channel: { select: { kind: true, expert: true } },
    },
    take: 50,
  });
  for (const msg of due) {
    // Auteur retiré du salon depuis la programmation : le message n'y partira
    // jamais. removeMember le supprime déjà au retrait ; ceci couvre les plus
    // anciens et une programmation concurrente du retrait.
    if (!(await isMember(msg.authorId, msg.channelId))) {
      await prisma.message.delete({ where: { id: msg.id } });
      await Promise.all(msg.attachments.map((a) => safeUnlink(a.storagePath)));
      continue;
    }
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
      void dispatchExpertTurn(
        io,
        msg.channelId,
        updated.searchableBody || "",
        { displayName: msg.author?.displayName ?? null },
        msg.channel.expert || DEFAULT_EXPERT
      );
    }
  }
}
