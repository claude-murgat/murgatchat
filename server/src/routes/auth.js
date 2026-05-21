import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db.js";
import { signToken, requireAuth } from "../auth.js";

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
});

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, username, displayName, password } = parsed.data;

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
  });
  if (existing) return res.status(409).json({ error: "email_or_username_taken" });

  const passwordHash = await bcrypt.hash(password, 10);
  const color = palette[Math.floor(Math.random() * palette.length)];
  const user = await prisma.user.create({
    data: { email, username, displayName, passwordHash, avatarColor: color },
  });

  const def = await prisma.channel.findFirst({ where: { isDefault: true } });
  if (def) {
    await prisma.membership
      .create({ data: { userId: user.id, channelId: def.id } })
      .catch(() => {});
  }

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
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

export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    displayName: u.displayName,
    avatarColor: u.avatarColor,
    status: u.status,
    dndUntil: u.dndUntil,
  };
}

export default router;
