import { Router } from "express";
import { prisma } from "../db.ts";
import { requireAuth } from "../auth.ts";
import { publicUser } from "./auth.ts";
import { BOT_USERNAME } from "../notify.ts";

const router = Router();

// Annuaire des sélecteurs de personnes (nouveau message, ajout à un salon,
// recherche) : seulement des comptes actifs — un compte désactivé ne lit plus
// rien, et le bot technique « Claude » ne répond que dans la section CLAUDE.
router.get("/", requireAuth, async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  const users = await prisma.user.findMany({
    where: {
      status: "active",
      username: { not: BOT_USERNAME },
      ...(q
        ? {
            OR: [
              { username: { contains: q, mode: "insensitive" } },
              { displayName: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { displayName: "asc" },
    take: 50,
  });
  res.json({ users: users.map(publicUser) });
});

export default router;
