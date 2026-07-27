import { Router } from "express";
import { prisma } from "../db.ts";
import { requireAuth } from "../auth.ts";
import { publicUser } from "./auth.ts";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  const users = await prisma.user.findMany({
    where: q
      ? {
          OR: [
            { username: { contains: q, mode: "insensitive" } },
            { displayName: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
          ],
        }
      : undefined,
    orderBy: { displayName: "asc" },
    take: 50,
  });
  res.json({ users: users.map(publicUser) });
});

export default router;
