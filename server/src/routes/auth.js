import { Router } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db.js";
import { signToken, requireAuth } from "../auth.js";
import { broadcastMembers } from "./channels.js";
import { sendInvitationEmail, inviteLink } from "../mail.js";

const router = Router();

const palette = [
  "#4A154B", "#1264A3", "#2BAC76", "#E01E5A",
  "#ECB22E", "#36C5F0", "#8E44AD", "#16A085",
];

const registerSchema = z.object({
  email: z.string().email(),
  username: z.string().min(2).max(30).regex(/^[a-zA-Z0-9_.-]+$/),
  displayName: z.string().min(1).max(60),
  password: z.string().min(6).max(200),
  token: z.string().optional(), // invitation token
});

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, username, displayName, password, token: inviteToken } = parsed.data;

  // Bootstrap: the very first account (empty DB) is created without an invitation
  // and becomes admin. Everyone else needs a valid invitation.
  const isBootstrap = (await prisma.user.count()) === 0;

  let invitation = null;
  if (!isBootstrap) {
    if (!inviteToken) return res.status(403).json({ error: "invitation_required" });
    invitation = await prisma.invitation.findUnique({ where: { token: inviteToken } });
    if (!invitation || invitation.acceptedAt) {
      return res.status(403).json({ error: "invalid_invitation" });
    }
    if (invitation.expiresAt < new Date()) {
      return res.status(403).json({ error: "invitation_expired" });
    }
    if (invitation.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(403).json({ error: "invitation_email_mismatch" });
    }
  }

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
  });
  if (existing) return res.status(409).json({ error: "email_or_username_taken" });

  const passwordHash = await bcrypt.hash(password, 10);
  const color = palette[Math.floor(Math.random() * palette.length)];
  const user = await prisma.user.create({
    data: {
      email,
      username,
      displayName,
      passwordHash,
      avatarColor: color,
      isAdmin: isBootstrap,
    },
  });

  if (invitation) {
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });
  }

  const def = await prisma.channel.findFirst({ where: { isDefault: true } });
  if (def) {
    await prisma.membership
      .create({ data: { userId: user.id, channelId: def.id } })
      .catch(() => {});
    await broadcastMembers(req.io, def.id);
  }

  const authToken = signToken(user);
  res.json({ token: authToken, user: publicUser(user) });
});

const loginSchema = z.object({
  emailOrUsername: z.string().min(1),
  password: z.string().min(1),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { emailOrUsername, password } = parsed.data;

  const user = await prisma.user.findFirst({
    where: { OR: [{ email: emailOrUsername }, { username: emailOrUsername }] },
  });
  if (!user) return res.status(401).json({ error: "invalid_credentials" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({ user: publicUser(user) });
});

router.post("/dnd", requireAuth, async (req, res) => {
  const { minutes } = req.body || {};
  let dndUntil = null;
  if (typeof minutes === "number" && minutes > 0) {
    dndUntil = new Date(Date.now() + minutes * 60_000);
  }
  const user = await prisma.user.update({
    where: { id: req.userId },
    data: { dndUntil },
  });
  res.json({ user: publicUser(user) });
});

router.post("/dnd-schedule", requireAuth, async (req, res) => {
  const { enabled, start, end } = req.body || {};
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (enabled && (!timeRe.test(start || "") || !timeRe.test(end || ""))) {
    return res.status(400).json({ error: "invalid_time" });
  }
  const user = await prisma.user.update({
    where: { id: req.userId },
    data: {
      dndScheduleEnabled: !!enabled,
      dndStart: enabled ? start : null,
      dndEnd: enabled ? end : null,
    },
  });
  res.json({ user: publicUser(user) });
});

router.post("/push-token", requireAuth, async (req, res) => {
  const { token, platform } = req.body || {};
  if (typeof token !== "string" || !token.trim()) {
    return res.status(400).json({ error: "invalid_token" });
  }
  await prisma.pushToken.upsert({
    where: { token },
    update: { userId: req.userId, platform: platform || "android" },
    create: { token, userId: req.userId, platform: platform || "android" },
  });
  res.json({ ok: true });
});

router.delete("/push-token", requireAuth, async (req, res) => {
  const { token } = req.body || {};
  if (token) {
    await prisma.pushToken.deleteMany({ where: { token, userId: req.userId } });
  }
  res.json({ ok: true });
});

async function requireAdmin(req, res, next) {
  const u = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!u?.isAdmin) return res.status(403).json({ error: "admin_required" });
  req.adminUser = u;
  next();
}

const inviteSchema = z.object({ email: z.string().email() });
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Admin-only: create an invitation for an email and send it (link + code).
router.post("/invitations", requireAuth, requireAdmin, async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const email = parsed.data.email.toLowerCase();

  if (await prisma.user.findUnique({ where: { email } })) {
    return res.status(409).json({ error: "already_registered" });
  }
  // Replace any prior pending invitation for the same email.
  await prisma.invitation.deleteMany({ where: { email, acceptedAt: null } });

  const token = crypto.randomBytes(16).toString("hex");
  const inv = await prisma.invitation.create({
    data: {
      email,
      token,
      invitedBy: req.userId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  let emailSent = false;
  try {
    ({ sent: emailSent } = await sendInvitationEmail({
      to: email,
      token,
      inviterName: req.adminUser.displayName,
    }));
  } catch (e) {
    console.error("[invitations] email send failed:", e.message);
  }
  res.json({ invitation: serializeInvitation(inv), token, link: inviteLink(token), emailSent });
});

// Admin-only: list invitations.
router.get("/invitations", requireAuth, requireAdmin, async (_req, res) => {
  const invitations = await prisma.invitation.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json({ invitations: invitations.map(serializeInvitation) });
});

// Public: validate a token + reveal the invited email so the register form can prefill.
router.get("/invitations/:token", async (req, res) => {
  const inv = await prisma.invitation.findUnique({ where: { token: req.params.token } });
  if (!inv) return res.status(404).json({ error: "not_found" });
  const expired = inv.expiresAt < new Date();
  const accepted = !!inv.acceptedAt;
  res.json({ email: inv.email, valid: !expired && !accepted, expired, accepted });
});

function serializeInvitation(inv) {
  return {
    id: inv.id,
    email: inv.email,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    acceptedAt: inv.acceptedAt ?? null,
    pending: !inv.acceptedAt && new Date(inv.expiresAt) > new Date(),
    link: inviteLink(inv.token),
  };
}

export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    displayName: u.displayName,
    avatarColor: u.avatarColor,
    status: u.status,
    isAdmin: u.isAdmin,
    dndUntil: u.dndUntil,
    dndScheduleEnabled: u.dndScheduleEnabled,
    dndStart: u.dndStart,
    dndEnd: u.dndEnd,
  };
}

export default router;
