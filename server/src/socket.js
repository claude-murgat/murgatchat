import { Server } from "socket.io";
import { verifyToken } from "./auth.js";
import { prisma } from "./db.js";
import { serializeMessage } from "./routes/channels.js";
import { encryptBody } from "./crypto.js";

// DnD actif si fenêtre ponctuelle (dndUntil) OU plage quotidienne (heure serveur)
export function isUserDnd(user, now = new Date()) {
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

export function setupSocket(httpServer, corsOrigin) {
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin || "*", credentials: false },
  });

  // userId -> number of active sockets (a user can have several tabs/devices)
  const online = new Map();

  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer /, "");
    const payload = token ? verifyToken(token) : null;
    if (!payload) return next(new Error("unauthorized"));
    socket.data.userId = payload.sub;
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
        const trimmed = (body || "").trim();
        if (!channelId || (!trimmed && attachmentIds.length === 0)) {
          return ack?.({ error: "invalid_payload" });
        }
        const member = await prisma.membership.findUnique({
          where: { userId_channelId: { userId, channelId } },
        });
        if (!member) return ack?.({ error: "not_a_member" });

        if (parentId) {
          const parent = await prisma.message.findUnique({ where: { id: parentId } });
          if (!parent || parent.channelId !== channelId || !parent.delivered || parent.parentId) {
            return ack?.({ error: "invalid_parent" });
          }
        }

        if (attachmentIds.length) {
          const valid = await prisma.attachment.findMany({
            where: {
              id: { in: attachmentIds },
              uploadedBy: userId,
              messageId: null,
            },
            select: { id: true },
          });
          if (valid.length !== attachmentIds.length) {
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
            parentId: parentId || null,
            scheduledAt: isScheduled ? scheduledDate : null,
            delivered: !isScheduled,
          },
          include: { author: true, attachments: true },
        });

        if (attachmentIds.length) {
          await prisma.attachment.updateMany({
            where: { id: { in: attachmentIds } },
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

        const serialized = serializeMessage(msg);
        io.to(`channel:${channelId}`).emit(
          msg.parentId ? "thread:reply" : "message:new",
          serialized
        );

        const channelMembers = await prisma.membership.findMany({
          where: { channelId },
          include: { user: true },
        });
        for (const cm of channelMembers) {
          if (cm.userId === userId) continue;
          const isDnd = isUserDnd(cm.user);
          if (!isDnd) {
            io.to(`user:${cm.userId}`).emit("notification", {
              channelId,
              message: serialized,
            });
          }
        }
        ack?.({ ok: true, message: serialized });
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

export async function dispatchScheduledMessages(io) {
  const now = new Date();
  const due = await prisma.message.findMany({
    where: { delivered: false, scheduledAt: { lte: now } },
    include: { author: true },
    take: 50,
  });
  for (const msg of due) {
    const updated = await prisma.message.update({
      where: { id: msg.id },
      data: { delivered: true, createdAt: msg.scheduledAt },
      include: { author: true, attachments: true },
    });
    const serialized = serializeMessage(updated);
    io.to(`channel:${msg.channelId}`).emit("message:new", serialized);

    const channelMembers = await prisma.membership.findMany({
      where: { channelId: msg.channelId },
      include: { user: true },
    });
    for (const cm of channelMembers) {
      if (cm.userId === msg.authorId) continue;
      const isDnd = cm.user.dndUntil && cm.user.dndUntil > new Date();
      if (!isDnd) {
        io.to(`user:${cm.userId}`).emit("notification", {
          channelId: msg.channelId,
          message: serialized,
        });
      }
    }
  }
}
