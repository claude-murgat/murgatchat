import { Router } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db.js";
import { signToken, requireAuth } from "../auth.js";
import { broadcastMembers } from "./channels.js";
import { sendInvitationEmail, sendPasswordResetEmail, inviteLink } from "../mail.js";

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
      // Bootstrap = first account on a fresh deploy = admin AND owner.
      // Subsequent accounts (registered via invitation) are plain members.
      isAdmin: isBootstrap,
      isOwner: isBootstrap,
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
  // Soft-deleted account: same error as a wrong password (no enumeration).
  if (user.status === "disabled") return res.status(401).json({ error: "invalid_credentials" });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({ user: publicUser(user) });
});

// Profile update: change displayName and/or password. Password change requires
// the current password (defence-in-depth against a stolen session/token).
const profileSchema = z
  .object({
    displayName: z.string().min(1).max(60).optional(),
    currentPassword: z.string().min(1).optional(),
    newPassword: z.string().min(6).max(200).optional(),
  })
  .refine((d) => d.displayName !== undefined || d.newPassword !== undefined, {
    message: "no_changes",
  })
  .refine((d) => !d.newPassword || !!d.currentPassword, {
    path: ["currentPassword"],
    message: "current_password_required",
  });

router.patch("/me", requireAuth, async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { displayName, currentPassword, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: "not_found" });

  const data = {};
  if (displayName !== undefined) data.displayName = displayName;
  if (newPassword) {
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(403).json({ error: "invalid_current_password" });
    data.passwordHash = await bcrypt.hash(newPassword, 10);
  }
  const updated = await prisma.user.update({ where: { id: user.id }, data });
  res.json({ user: publicUser(updated) });
});

// --- Password reset ---------------------------------------------------------
// Anti-enumeration: forgot-password ALWAYS returns 200 regardless of whether
// the account exists. The reset row + email are only created/sent if it does.
const RESET_TTL_MS = 60 * 60 * 1000;
const forgotSchema = z.object({ emailOrUsername: z.string().min(1) });

router.post("/forgot-password", async (req, res) => {
  const parsed = forgotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = parsed.data.emailOrUsername.trim();

  const user = await prisma.user.findFirst({
    where: { OR: [{ email: id.toLowerCase() }, { email: id }, { username: id }] },
  });
  if (user) {
    // Invalidate any pending reset for this user, then mint a new one.
    await prisma.passwordReset.deleteMany({
      where: { userId: user.id, usedAt: null },
    });
    const token = crypto.randomBytes(24).toString("hex");
    await prisma.passwordReset.create({
      data: {
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });
    try {
      await sendPasswordResetEmail({
        to: user.email,
        token,
        displayName: user.displayName,
      });
    } catch (e) {
      console.error("[reset] email send failed:", e.message);
    }
  }
  res.json({ ok: true });
});

// Validate a reset token (public) — reveals only the masked email so the UI
// can confirm to the user "you're resetting alice@…" without leaking accounts.
router.get("/password-reset/:token", async (req, res) => {
  const row = await prisma.passwordReset.findUnique({
    where: { token: req.params.token },
    include: { user: true },
  });
  if (!row) return res.status(404).json({ valid: false, error: "not_found" });
  const expired = row.expiresAt < new Date();
  const used = !!row.usedAt;
  res.json({
    valid: !expired && !used,
    expired,
    used,
    email: row.user ? maskEmail(row.user.email) : null,
  });
});

const resetSchema = z.object({
  token: z.string().min(8),
  password: z.string().min(6).max(200),
});

router.post("/reset-password", async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { token, password } = parsed.data;

  const row = await prisma.passwordReset.findUnique({ where: { token } });
  if (!row || row.usedAt) return res.status(403).json({ error: "invalid_token" });
  if (row.expiresAt < new Date()) return res.status(403).json({ error: "expired_token" });

  const passwordHash = await bcrypt.hash(password, 10);
  const [, , user] = await prisma.$transaction([
    prisma.passwordReset.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    // Defence in depth: invalidate any OTHER pending reset for this user.
    prisma.passwordReset.deleteMany({
      where: { userId: row.userId, usedAt: null, NOT: { id: row.id } },
    }),
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash } }),
  ]);
  // Auto-login after a successful reset so the user lands in the app.
  const authToken = signToken(user);
  res.json({ token: authToken, user: publicUser(user) });
});

function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  if (!domain) return email;
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}${local.length > 2 ? "***" : ""}@${domain}`;
}

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

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: "admin_required" });
  // Back-compat with older code that read req.adminUser.
  req.adminUser = req.user;
  next();
}

function requireOwner(req, res, next) {
  if (!req.user?.isOwner) return res.status(403).json({ error: "owner_required" });
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

// --- Admin panel: list users + manage roles + soft delete + transfer ownership

// Admin-only: list all users (with role + status) for the admin panel.
// Admin-only: paginated user list with optional case-insensitive search
// (matches displayName / username / email; OR-combined). `pageSize` is
// clamped to [1, 100] so a misbehaving client can't ask for everything.
router.get("/users", requireAuth, requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  const where = q
    ? {
        OR: [
          { displayName: { contains: q, mode: "insensitive" } },
          { username: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      }
    : {};

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: [{ isOwner: "desc" }, { isAdmin: "desc" }, { displayName: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  res.json({
    users: users.map(publicUser),
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  });
});

const userPatchSchema = z
  .object({
    isAdmin: z.boolean().optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine((d) => d.isAdmin !== undefined || d.status !== undefined, {
    message: "no_changes",
  });

// Admin-only: change a user's role/status with field-level permission checks.
//   - isAdmin: owner only (and never targets the owner herself; promote/revoke)
//   - status:  admin can disable a plain member; owner is required to disable
//              another admin; owner cannot be disabled or revoked at all
//              (must transfer ownership first).
router.patch("/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const parsed = userPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { isAdmin, status } = parsed.data;

  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "not_found" });

  const me = req.user;
  if (target.isOwner) {
    return res.status(403).json({ error: "owner_protected" });
  }

  const data = {};

  if (isAdmin !== undefined) {
    if (!me.isOwner) return res.status(403).json({ error: "owner_required" });
    if (target.id === me.id) return res.status(403).json({ error: "self_demote_forbidden" });
    data.isAdmin = isAdmin;
    // Demoting an admin to member: also clears their admin if they have it.
  }

  if (status !== undefined) {
    if (status === "disabled") {
      // Can't disable an admin unless you're the owner.
      if (target.isAdmin && !me.isOwner) {
        return res.status(403).json({ error: "owner_required_for_admin" });
      }
      if (target.id === me.id) return res.status(403).json({ error: "self_disable_forbidden" });
    }
    data.status = status;
  }

  const updated = await prisma.user.update({ where: { id: target.id }, data });
  res.json({ user: publicUser(updated) });
});

const transferSchema = z.object({ targetUserId: z.string().min(1) });

// Owner-only: hand ownership to another user. The previous owner stays admin
// (per the product decision; never silently demoted to a plain member). The
// new owner is also forced to admin so they can use admin tools immediately.
router.post("/transfer-ownership", requireAuth, requireOwner, async (req, res) => {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { targetUserId } = parsed.data;
  const me = req.user;

  if (targetUserId === me.id) return res.status(400).json({ error: "already_owner" });
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) return res.status(404).json({ error: "not_found" });
  if (target.status === "disabled") return res.status(400).json({ error: "target_disabled" });

  // Atomic swap so the database is never momentarily without an owner.
  const [, newOwner] = await prisma.$transaction([
    prisma.user.update({
      where: { id: me.id },
      data: { isOwner: false, isAdmin: true },
    }),
    prisma.user.update({
      where: { id: target.id },
      data: { isOwner: true, isAdmin: true },
    }),
  ]);
  res.json({ newOwner: publicUser(newOwner) });
});

// Self-heal an existing deployment where someone is admin but nobody is owner.
// Promotes the oldest admin (createdAt asc) to owner. No-op on a healthy DB.
// Called at startup so an alpha that pre-dates User.isOwner gets fixed silently.
export async function ensureOwner() {
  const owner = await prisma.user.findFirst({ where: { isOwner: true } });
  if (owner) return owner;
  const firstAdmin = await prisma.user.findFirst({
    where: { isAdmin: true },
    orderBy: { createdAt: "asc" },
  });
  if (!firstAdmin) return null;
  return prisma.user.update({
    where: { id: firstAdmin.id },
    data: { isOwner: true },
  });
}

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
    isOwner: u.isOwner,
    dndUntil: u.dndUntil,
    dndScheduleEnabled: u.dndScheduleEnabled,
    dndStart: u.dndStart,
    dndEnd: u.dndEnd,
  };
}

export default router;
