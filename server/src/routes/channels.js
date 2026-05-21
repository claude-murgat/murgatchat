import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../auth.js";
import { publicUser } from "./auth.js";
import { encryptBody, decryptBody } from "../crypto.js";

const router = Router();

async function broadcastMembers(io, channelId) {
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
  ids = [...new Set(ids.filter((id) => id && id !== req.userId))];
  if (ids.length === 0) return res.status(400).json({ error: "invalid_target" });

  const found = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  if (found.length !== ids.length) {
    return res.status(400).json({ error: "invalid_target" });
  }

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

  const messages = await prisma.message.findMany({
    where: { channelId: id, delivered: true, parentId: null },
    include: {
      author: true,
      attachments: true,
      reactions: { include: { user: true } },
      _count: { select: { replies: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  res.json({ messages: messages.map(serializeMessage) });
});

router.get("/messages/:messageId/thread", requireAuth, async (req, res) => {
  const { messageId } = req.params;
  const parent = await prisma.message.findUnique({
    where: { id: messageId },
    include: {
      author: true,
      attachments: true,
      reactions: { include: { user: true } },
      _count: { select: { replies: true } },
    },
  });
  if (!parent) return res.status(404).json({ error: "not_found" });
  const member = await prisma.membership.findUnique({
    where: { userId_channelId: { userId: req.userId, channelId: parent.channelId } },
  });
  if (!member) return res.status(403).json({ error: "not_a_member" });

  const replies = await prisma.message.findMany({
    where: { parentId: messageId, delivered: true },
    include: {
      author: true,
      attachments: true,
      reactions: { include: { user: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  res.json({ parent: serializeMessage(parent), replies: replies.map(serializeMessage) });
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

router.delete("/scheduled/:messageId", requireAuth, async (req, res) => {
  const { messageId } = req.params;
  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.authorId !== req.userId || msg.delivered) {
    return res.status(404).json({ error: "not_found" });
  }
  await prisma.message.delete({ where: { id: messageId } });
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
    data: { body: encryptBody(trimmed), editedAt: new Date() },
    include: {
      author: true,
      attachments: true,
      reactions: { include: { user: true } },
      _count: { select: { replies: true } },
    },
  });

  const serialized = serializeMessage(updated);
  req.io?.to(`channel:${updated.channelId}`).emit("message:updated", serialized);
  res.json({ message: serialized });
});

router.delete("/messages/:messageId", requireAuth, async (req, res) => {
  const { messageId } = req.params;
  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.authorId !== req.userId || !msg.delivered) {
    return res.status(404).json({ error: "not_found" });
  }
  const { channelId, parentId } = msg;
  await prisma.message.delete({ where: { id: messageId } });
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

export function serializeChannel(channel, viewerId) {
  const members = (channel.memberships || []).map((m) => publicUser(m.user));
  let displayName = channel.name;
  if (channel.isDirect) {
    const others = members.filter((u) => u.id !== viewerId);
    displayName = others.map((u) => u.displayName).join(", ") || "Direct";
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
    body: decryptBody(m.body),
    createdAt: m.createdAt,
    editedAt: m.editedAt ?? null,
    scheduledAt: m.scheduledAt,
    replyCount: m._count?.replies ?? 0,
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
