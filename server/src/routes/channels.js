import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../auth.js";
import { publicUser } from "./auth.js";
import { encryptBody, decryptBody } from "../crypto.js";
import { safeUnlink } from "../storage.js";

const router = Router();

export async function broadcastMembers(io, channelId) {
  const memberships = await prisma.membership.findMany({
    where: { channelId },
    include: { user: true },
  });
  io?.to(`channel:${channelId}`).emit("channel:members", {
    channelId,
    members: memberships.map((m) => publicUser(m.user)),
  });
}

router.get("/", requireAuth, async (req, res) => {
  const memberships = await prisma.membership.findMany({
    where: { userId: req.userId },
    include: {
      channel: {
        include: {
          memberships: { include: { user: true } },
          messages: { orderBy: { createdAt: "desc" }, take: 1, where: { delivered: true } },
        },
      },
    },
    orderBy: { joinedAt: "asc" },
  });

  const channels = memberships.map((m) => serializeChannel(m.channel, req.userId));
  res.json({ channels });
});

const createChannelSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  isPrivate: z.boolean().optional(),
  memberIds: z.array(z.string()).optional(),
});

router.post("/", requireAuth, async (req, res) => {
  const parsed = createChannelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { name, description, isPrivate, memberIds = [] } = parsed.data;

  const allMembers = Array.from(new Set([req.userId, ...memberIds]));
  const channel = await prisma.channel.create({
    data: {
      name,
      description,
      isPrivate: !!isPrivate,
      isDirect: false,
      memberships: { create: allMembers.map((userId) => ({ userId })) },
    },
    include: {
      memberships: { include: { user: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  for (const m of channel.memberships) {
    const personalized = serializeChannel(channel, m.userId);
    req.io?.to(`user:${m.userId}`).emit("channel:created", personalized);
    req.io?.in(`user:${m.userId}`).socketsJoin(`channel:${channel.id}`);
  }
  res.json({ channel: serializeChannel(channel, req.userId) });
});

router.post("/dm", requireAuth, async (req, res) => {
  const body = req.body || {};
  let ids = Array.isArray(body.userIds)
    ? body.userIds
    : body.userId
    ? [body.userId]
    : [];
  // We DO keep the caller's own id this time: a DM with just yourself is the
  // "notes pour soi" scratchpad. So `userIds=[]` and `userIds=[self]` both
  // resolve to the same single-member self-DM, and the others stay 2+ members.
  const isSelfOnly = ids.length === 0 || ids.every((id) => id === req.userId);
  ids = [...new Set(ids.filter((id) => id && id !== req.userId))];
  if (ids.length === 0 && !isSelfOnly) {
    return res.status(400).json({ error: "invalid_target" });
  }

  if (ids.length) {
    const found = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      return res.status(400).json({ error: "invalid_target" });
    }
  }

  // Always include the caller. For a self-DM, that's the *only* member.
  const targetIds = [...new Set([req.userId, ...ids])];
  const include = {
    memberships: { include: { user: true } },
    messages: { orderBy: { createdAt: "desc" }, take: 1 },
  };

  // Réutiliser un DM existant avec exactement le même ensemble de membres
  const candidates = await prisma.channel.findMany({
    where: {
      isDirect: true,
      AND: targetIds.map((uid) => ({ memberships: { some: { userId: uid } } })),
    },
    include: { memberships: { select: { userId: true } } },
  });
  const existingId = candidates.find(
    (c) => c.memberships.length === targetIds.length
  )?.id;
  if (existingId) {
    const full = await prisma.channel.findUnique({ where: { id: existingId }, include });
    return res.json({ channel: serializeChannel(full, req.userId) });
  }

  const channel = await prisma.channel.create({
    data: {
      isDirect: true,
      memberships: { create: targetIds.map((userId) => ({ userId })) },
    },
    include,
  });
  for (const m of channel.memberships) {
    const personalized = serializeChannel(channel, m.userId);
    req.io?.to(`user:${m.userId}`).emit("channel:created", personalized);
    req.io?.in(`user:${m.userId}`).socketsJoin(`channel:${channel.id}`);
  }
  res.json({ channel: serializeChannel(channel, req.userId) });
});

router.get("/:id/messages", requireAuth, async (req, res) => {
  const { id } = req.params;
  const member = await prisma.membership.findUnique({
    where: { userId_channelId: { userId: req.userId, channelId: id } },
  });
  if (!member) return res.status(403).json({ error: "not_a_member" });

  // Discord/Messenger model: replies live inline in the timeline alongside
  // root messages, with a quote of the parent rendered above each reply.
  // (Old Slack-thread model filtered out anything with parentId.)
  // Pagination par curseur, du plus récent vers le plus ancien. Par défaut on
  // renvoie les 200 messages les PLUS RÉCENTS ; `?before=<messageId>` charge les
  // 200 antérieurs à ce message (curseur Prisma stable grâce au tie-break sur
  // l'id). On récupère PAGE+1 lignes pour savoir s'il reste du plus ancien, puis
  // on renvoie la page triée du plus ancien au plus récent (ordre d'affichage).
  const PAGE = 200;
  const before = typeof req.query.before === "string" ? req.query.before : null;
  const rows = await prisma.message.findMany({
    where: { channelId: id, delivered: true },
    include: {
      author: true,
      attachments: true,
      reactions: { include: { user: true } },
      // Hydrate the parent (author + body for the quote bubble). Cheap because
      // we only ever go one level deep — replies-to-replies are rejected at
      // send time.
      parent: { include: { author: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE + 1,
    ...(before ? { cursor: { id: before }, skip: 1 } : {}),
  });
  const hasMore = rows.length > PAGE;
  const page = rows.slice(0, PAGE); // plus récent -> plus ancien
  const oldestId = page.length ? page[page.length - 1].id : null;
  res.json({
    messages: page.reverse().map(serializeMessage), // plus ancien -> plus récent
    hasMore,
    nextCursor: hasMore ? oldestId : null,
  });
});

router.get("/:id/scheduled", requireAuth, async (req, res) => {
  const { id } = req.params;
  const scheduled = await prisma.message.findMany({
    where: {
      channelId: id,
      authorId: req.userId,
      delivered: false,
      scheduledAt: { not: null },
    },
    include: { attachments: true },
    orderBy: { scheduledAt: "asc" },
  });
  res.json({ scheduled: scheduled.map(serializeScheduled) });
});

// Same blob-cleanup logic as the regular delete: scheduled messages also carry
// attachments we want to remove from disk immediately on cancel.
router.delete("/scheduled/:messageId", requireAuth, async (req, res) => {
  const { messageId } = req.params;
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    include: { attachments: true },
  });
  if (!msg || msg.authorId !== req.userId || msg.delivered) {
    return res.status(404).json({ error: "not_found" });
  }
  const blobs = (msg.attachments || []).map((a) => a.storagePath);
  await prisma.message.delete({ where: { id: messageId } });
  await Promise.all(blobs.map((p) => safeUnlink(p)));
  res.json({ ok: true });
});

router.patch("/scheduled/:messageId", requireAuth, async (req, res) => {
  const { messageId } = req.params;
  const { body, scheduledAt } = req.body || {};

  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.authorId !== req.userId || msg.delivered) {
    return res.status(404).json({ error: "not_found" });
  }

  const data = {};
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return res.status(400).json({ error: "empty_body" });
    data.body = encryptBody(trimmed);
    data.searchableBody = trimmed; // keep the FTS index in sync
  }
  if (scheduledAt !== undefined) {
    const date = new Date(scheduledAt);
    if (isNaN(date.getTime()) || date.getTime() <= Date.now() + 1000) {
      return res.status(400).json({ error: "scheduled_at_must_be_future" });
    }
    data.scheduledAt = date;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "nothing_to_update" });
  }

  const updated = await prisma.message.update({
    where: { id: messageId },
    data,
    include: { attachments: true },
  });
  res.json({ scheduled: serializeScheduled(updated) });
});

router.patch("/messages/:messageId", requireAuth, async (req, res) => {
  const { messageId } = req.params;
  const { body } = req.body || {};

  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.authorId !== req.userId || !msg.delivered) {
    return res.status(404).json({ error: "not_found" });
  }

  const trimmed = typeof body === "string" ? body.trim() : "";
  if (!trimmed) return res.status(400).json({ error: "empty_body" });

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: {
      body: encryptBody(trimmed),
      // Plaintext FTS mirror; see schema note on the privacy trade-off.
      searchableBody: trimmed,
      editedAt: new Date(),
    },
    include: {
      author: true,
      attachments: true,
      reactions: { include: { user: true } },
      // Re-hydrate the parent so the inline quote survives the edit. Without it,
      // serializeMessage emits parent:null and clients drop the quote bubble
      // until a reload re-fetches via GET /messages (which already includes it).
      parent: { include: { author: true } },
    },
  });

  const serialized = serializeMessage(updated);
  req.io?.to(`channel:${updated.channelId}`).emit("message:updated", serialized);
  res.json({ message: serialized });
});

router.delete("/messages/:messageId", requireAuth, async (req, res) => {
  const { messageId } = req.params;
  // Pre-fetch attachments (own + via cascaded replies) so we can unlink the
  // blobs on disk after the DB cascade removes their rows. The sweep worker
  // is the safety net; this is the happy path.
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    include: {
      attachments: true,
      replies: { include: { attachments: true } },
    },
  });
  if (!msg || msg.authorId !== req.userId || !msg.delivered) {
    return res.status(404).json({ error: "not_found" });
  }
  const blobs = [
    ...msg.attachments,
    ...(msg.replies || []).flatMap((r) => r.attachments || []),
  ].map((a) => a.storagePath);
  const { channelId, parentId } = msg;
  await prisma.message.delete({ where: { id: messageId } });
  await Promise.all(blobs.map((p) => safeUnlink(p)));
  req.io
    ?.to(`channel:${channelId}`)
    .emit("message:deleted", { id: messageId, channelId, parentId });
  res.json({ ok: true });
});

router.post("/messages/:messageId/reactions", requireAuth, async (req, res) => {
  const { messageId } = req.params;
  const emoji = typeof req.body?.emoji === "string" ? req.body.emoji.trim() : "";
  if (!emoji || emoji.length > 32) {
    return res.status(400).json({ error: "invalid_emoji" });
  }

  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg) return res.status(404).json({ error: "not_found" });
  const member = await prisma.membership.findUnique({
    where: { userId_channelId: { userId: req.userId, channelId: msg.channelId } },
  });
  if (!member) return res.status(403).json({ error: "not_a_member" });

  const existing = await prisma.reaction.findUnique({
    where: { messageId_userId_emoji: { messageId, userId: req.userId, emoji } },
  });
  if (existing) {
    await prisma.reaction.delete({ where: { id: existing.id } });
  } else {
    await prisma.reaction.create({ data: { messageId, userId: req.userId, emoji } });
  }

  const reactions = await prisma.reaction.findMany({
    where: { messageId },
    include: { user: true },
  });
  const grouped = groupReactions(reactions);
  req.io
    ?.to(`channel:${msg.channelId}`)
    .emit("reaction:update", { messageId, reactions: grouped });
  res.json({ messageId, reactions: grouped });
});

router.get("/public", requireAuth, async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const channels = await prisma.channel.findMany({
    where: {
      isDirect: false,
      isPrivate: false,
      memberships: { none: { userId: req.userId } },
      ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
    },
    include: {
      memberships: { include: { user: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  res.json({ channels: channels.map((c) => serializeChannel(c, req.userId)) });
});

router.post("/:id/join", requireAuth, async (req, res) => {
  const { id } = req.params;
  const channel = await prisma.channel.findUnique({ where: { id } });
  if (!channel || channel.isDirect || channel.isPrivate) {
    return res.status(404).json({ error: "not_found" });
  }
  await prisma.membership
    .create({ data: { userId: req.userId, channelId: id } })
    .catch(() => {});
  const full = await prisma.channel.findUnique({
    where: { id },
    include: {
      memberships: { include: { user: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  const personalized = serializeChannel(full, req.userId);
  req.io?.to(`user:${req.userId}`).emit("channel:created", personalized);
  req.io?.in(`user:${req.userId}`).socketsJoin(`channel:${id}`);
  await broadcastMembers(req.io, id);
  res.json({ channel: personalized });
});

router.post("/:id/members", requireAuth, async (req, res) => {
  const { id } = req.params;
  const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
  if (userIds.length === 0) return res.status(400).json({ error: "no_users" });

  const channel = await prisma.channel.findUnique({ where: { id } });
  if (!channel || channel.isDirect) return res.status(404).json({ error: "not_found" });
  const requester = await prisma.membership.findUnique({
    where: { userId_channelId: { userId: req.userId, channelId: id } },
  });
  if (!requester) return res.status(403).json({ error: "not_a_member" });

  const valid = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true },
  });
  await prisma.membership.createMany({
    data: valid.map((u) => ({ userId: u.id, channelId: id })),
    skipDuplicates: true,
  });

  const full = await prisma.channel.findUnique({
    where: { id },
    include: {
      memberships: { include: { user: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  for (const u of valid) {
    const personalized = serializeChannel(full, u.id);
    req.io?.to(`user:${u.id}`).emit("channel:created", personalized);
    req.io?.in(`user:${u.id}`).socketsJoin(`channel:${id}`);
  }
  await broadcastMembers(req.io, id);
  res.json({ channel: serializeChannel(full, req.userId) });
});

router.post("/:id/leave", requireAuth, async (req, res) => {
  const { id } = req.params;
  const channel = await prisma.channel.findUnique({ where: { id } });
  if (!channel || channel.isDirect) return res.status(404).json({ error: "not_found" });
  if (channel.isDefault) return res.status(403).json({ error: "cannot_leave_default" });
  await prisma.membership.deleteMany({ where: { channelId: id, userId: req.userId } });
  req.io?.to(`user:${req.userId}`).emit("channel:removed", { channelId: id });
  req.io?.in(`user:${req.userId}`).socketsLeave(`channel:${id}`);
  await broadcastMembers(req.io, id);
  res.json({ ok: true });
});

router.delete("/:id/members/:userId", requireAuth, async (req, res) => {
  const { id, userId } = req.params;
  const channel = await prisma.channel.findUnique({ where: { id } });
  if (!channel || channel.isDirect) return res.status(404).json({ error: "not_found" });
  if (channel.isDefault) {
    return res.status(403).json({ error: "cannot_remove_from_default" });
  }
  const requester = await prisma.membership.findUnique({
    where: { userId_channelId: { userId: req.userId, channelId: id } },
  });
  if (!requester) return res.status(403).json({ error: "not_a_member" });
  await prisma.membership.deleteMany({ where: { channelId: id, userId } });
  req.io?.to(`user:${userId}`).emit("channel:removed", { channelId: id });
  req.io?.in(`user:${userId}`).socketsLeave(`channel:${id}`);
  await broadcastMembers(req.io, id);
  res.json({ ok: true });
});

// Niveau de notification de l'appelant pour ce channel : "all" | "mentions" | "none".
// Stocké sur sa propre Membership ; n'affecte que lui (pas les autres membres).
const notifyLevelSchema = z.object({
  level: z.enum(["all", "mentions", "none"]),
});

router.patch("/:id/notifications", requireAuth, async (req, res) => {
  const parsed = notifyLevelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const membership = await prisma.membership.findUnique({
    where: { userId_channelId: { userId: req.userId, channelId: req.params.id } },
  });
  if (!membership) return res.status(404).json({ error: "not_a_member" });
  await prisma.membership.update({
    where: { id: membership.id },
    data: { notifyLevel: parsed.data.level },
  });
  res.json({ ok: true, notifyLevel: parsed.data.level });
});

export function serializeChannel(channel, viewerId) {
  const members = (channel.memberships || []).map((m) => publicUser(m.user));
  let displayName = channel.name;
  if (channel.isDirect) {
    const others = members.filter((u) => u.id !== viewerId);
    // Single-member DM where that member is the viewer = the "notes pour soi"
    // scratchpad. Anything else without other members shouldn't happen in
    // practice but we keep "Direct" as a safe fallback.
    if (others.length === 0) {
      const onlyMe = members.length === 1 && members[0].id === viewerId;
      displayName = onlyMe ? "Mes notes" : "Direct";
    } else {
      displayName = others.map((u) => u.displayName).join(", ");
    }
  }
  const last = channel.messages?.[0];
  const viewerMembership = (channel.memberships || []).find(
    (m) => m.userId === viewerId
  );
  const unread = !!(
    last &&
    last.authorId !== viewerId &&
    viewerMembership?.lastReadAt &&
    new Date(last.createdAt) > new Date(viewerMembership.lastReadAt)
  );
  return {
    id: channel.id,
    name: channel.name,
    displayName,
    isDirect: channel.isDirect,
    isPrivate: channel.isPrivate,
    isDefault: channel.isDefault,
    description: channel.description,
    // Niveau de notification de l'appelant pour ce channel (défaut "all" si la
    // membership n'est pas hydratée, p. ex. juste après une création).
    notifyLevel: viewerMembership?.notifyLevel || "all",
    members,
    lastMessage: last
      ? {
          id: last.id,
          body: decryptBody(last.body),
          createdAt: last.createdAt,
          authorId: last.authorId,
        }
      : null,
    unread,
  };
}

export function serializeAttachment(a) {
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
  };
}

export function groupReactions(reactions) {
  const map = new Map();
  for (const r of reactions || []) {
    if (!map.has(r.emoji)) map.set(r.emoji, []);
    map.get(r.emoji).push({ id: r.userId, displayName: r.user?.displayName });
  }
  return Array.from(map, ([emoji, users]) => ({
    emoji,
    count: users.length,
    users,
  }));
}

export function serializeMessage(m) {
  return {
    id: m.id,
    channelId: m.channelId,
    parentId: m.parentId ?? null,
    // Preview of the quoted message, when this is a reply. The client uses
    // it to render the inline quote without fetching the parent separately.
    parent: m.parent
      ? {
          id: m.parent.id,
          body: decryptBody(m.parent.body),
          author: m.parent.author ? publicUser(m.parent.author) : { id: m.parent.authorId },
        }
      : null,
    body: decryptBody(m.body),
    createdAt: m.createdAt,
    editedAt: m.editedAt ?? null,
    scheduledAt: m.scheduledAt,
    reactions: groupReactions(m.reactions),
    author: m.author ? publicUser(m.author) : { id: m.authorId },
    attachments: (m.attachments || []).map(serializeAttachment),
  };
}

export function serializeScheduled(m) {
  return {
    id: m.id,
    channelId: m.channelId,
    body: decryptBody(m.body),
    createdAt: m.createdAt,
    scheduledAt: m.scheduledAt,
    attachments: (m.attachments || []).map(serializeAttachment),
  };
}

export async function ensureDefaultChannel() {
  let channel = await prisma.channel.findFirst({ where: { isDefault: true } });
  if (!channel) {
    channel = await prisma.channel.create({
      data: { name: "Général", isDefault: true, isPrivate: false, isDirect: false },
    });
  }
  const users = await prisma.user.findMany({ select: { id: true } });
  const members = await prisma.membership.findMany({
    where: { channelId: channel.id },
    select: { userId: true },
  });
  const have = new Set(members.map((m) => m.userId));
  const toAdd = users
    .filter((u) => !have.has(u.id))
    .map((u) => ({ userId: u.id, channelId: channel.id }));
  if (toAdd.length) {
    await prisma.membership.createMany({ data: toAdd, skipDuplicates: true });
  }
  return channel;
}

export default router;
