// Pipeline → chat notifier. The support pipeline (claude-fix) calls
// POST /support/notify (see routes/support.js) when a PR is opened; this module
// posts that as an in-app message into a team channel so the team is notified
// without leaving MurgaChat.
//
// Optional, secret-gated: with no SUPPORT_NOTIFY_TOKEN the endpoint is disabled.
// Messages are authored by a dedicated bot user and reuse the normal message
// path (encrypted body + searchable plaintext), so they render like any message.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "./db.js";
import { encryptBody } from "./crypto.js";
import { serializeMessage } from "./routes/channels.js";

const BOT_USERNAME = "claude";

function token() {
  return process.env.SUPPORT_NOTIFY_TOKEN || "";
}
function channelName() {
  return process.env.SUPPORT_NOTIFY_CHANNEL || "support-dev";
}

export function notifyEnabled() {
  return Boolean(token());
}

// Constant-time comparison so the shared secret can't be guessed by timing.
export function tokenMatches(provided) {
  const expected = token();
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// A dedicated, non-loginable author for pipeline messages.
async function ensureBot() {
  let bot = await prisma.user.findUnique({ where: { username: BOT_USERNAME } });
  if (!bot) {
    bot = await prisma.user.create({
      data: {
        username: BOT_USERNAME,
        email: "claude-bot@murgatchat.local",
        displayName: "Claude",
        // Random, non-bcrypt hash → bcrypt.compare always fails, so the account
        // can never be logged into.
        passwordHash: randomBytes(24).toString("hex"),
        avatarColor: "#D97757",
      },
    });
  }
  return bot;
}

// The admin-only channel pipeline messages land in. Created on demand and kept
// PRIVATE so non-admins can't browse/join it (a public channel is listed by
// /channels/public and joinable via /channels/:id/join). Membership is
// reconciled to admins only on every notify: missing admins are added, and any
// non-admin is removed (covers demotions and rows from when this channel used to
// mirror every user). So only admins ever see the support pipeline feed.
async function ensureChannel() {
  const name = channelName();
  let channel = await prisma.channel.findFirst({
    where: { name, isDirect: false },
  });
  if (!channel) {
    channel = await prisma.channel.create({
      data: {
        name,
        isPrivate: true,
        isDirect: false,
        description: "Notifications du pipeline de support (Claude). Réservé aux admins.",
      },
    });
  } else if (!channel.isPrivate) {
    // Existing channel from before this was admin-only: lock it down.
    channel = await prisma.channel.update({
      where: { id: channel.id },
      data: { isPrivate: true },
    });
  }

  const admins = await prisma.user.findMany({
    where: { isAdmin: true },
    select: { id: true },
  });
  const adminIds = new Set(admins.map((u) => u.id));
  const existing = await prisma.membership.findMany({
    where: { channelId: channel.id },
    select: { userId: true },
  });
  const have = new Set(existing.map((m) => m.userId));

  const toAdd = admins
    .filter((u) => !have.has(u.id))
    .map((u) => ({ userId: u.id, channelId: channel.id }));
  if (toAdd.length) {
    await prisma.membership.createMany({ data: toAdd, skipDuplicates: true });
  }

  const toRemove = existing
    .filter((m) => !adminIds.has(m.userId))
    .map((m) => m.userId);
  if (toRemove.length) {
    await prisma.membership.deleteMany({
      where: { channelId: channel.id, userId: { in: toRemove } },
    });
  }

  return channel;
}

// Post `text` into the team channel as the bot. Returns the serialized message
// + channel/author ids so the caller can broadcast it over Socket.IO.
export async function postPipelineMessage(text) {
  const bot = await ensureBot();
  const channel = await ensureChannel();
  const msg = await prisma.message.create({
    data: {
      channelId: channel.id,
      authorId: bot.id,
      body: encryptBody(text),
      searchableBody: text,
      delivered: true,
    },
    include: {
      author: true,
      attachments: true,
      parent: { include: { author: true } },
    },
  });
  return { channelId: channel.id, authorId: bot.id, serialized: serializeMessage(msg) };
}
