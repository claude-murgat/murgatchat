import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../auth.js";
import { publicUser } from "./auth.js";
import { encryptBody, decryptBody } from "../crypto.js";

const router = Router();

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
  const { userId: otherId } = req.body || {};
  if (!otherId || otherId === req.userId) {
    return res.status(400).json({ error: "invalid_target" });
  }

  const existing = await prisma.channel.findFirst({
    where: {
      isDirect: true,
      AND: [
        { memberships: { some: { userId: req.userId } } },
        { memberships: { some: { userId: otherId } } },
      ],
    },
    include: {
      memberships: { include: { user: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  if (existing) {
    return res.json({ channel: serializeChannel(existing, req.userId) });
  }

  const channel = await prisma.channel.create({
    data: {
      isDirect: true,
      memberships: {
        create: [{ userId: req.userId }, { userId: otherId }],
      },
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

router.get("/:id/messages", requireAuth, async (req, res) => {
  const { id } = req.params;
  const member = await prisma.membership.findUnique({
    where: { userId_channelId: { userId: req.userId, channelId: id } },
  });
  if (!member) return res.status(403).json({ error: "not_a_member" });

  const messages = await prisma.message.findMany({
    where: { channelId: id, delivered: true },
    include: { author: true, attachments: true },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  res.json({ messages: messages.map(serializeMessage) });
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
    include: { author: true, attachments: true },
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
  const { channelId } = msg;
  await prisma.message.delete({ where: { id: messageId } });
  req.io?.to(`channel:${channelId}`).emit("message:deleted", { id: messageId, channelId });
  res.json({ ok: true });
});

export function serializeChannel(channel, viewerId) {
  const members = (channel.memberships || []).map((m) => publicUser(m.user));
  let displayName = channel.name;
  if (channel.isDirect) {
    const other = members.find((u) => u.id !== viewerId) || members[0];
    displayName = other?.displayName || "Direct";
  }
  const last = channel.messages?.[0];
  return {
    id: channel.id,
    name: channel.name,
    displayName,
    isDirect: channel.isDirect,
    isPrivate: channel.isPrivate,
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

export function serializeMessage(m) {
  return {
    id: m.id,
    channelId: m.channelId,
    body: decryptBody(m.body),
    createdAt: m.createdAt,
    editedAt: m.editedAt ?? null,
    scheduledAt: m.scheduledAt,
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

export default router;
