import jwt from "jsonwebtoken";
import { prisma } from "./db.js";

const SECRET = process.env.JWT_SECRET || "dev-secret";

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, username: user.username },
    SECRET,
    { expiresIn: "30d" }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

// Loads the user from DB so that a soft-deleted account (`status='disabled'`)
// is rejected immediately, even with a still-valid JWT. The user row is exposed
// as `req.user` so admin middlewares don't have to re-fetch.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: "unauthorized" });
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || user.status === "disabled") {
    return res.status(401).json({ error: "unauthorized" });
  }
  req.userId = user.id;
  req.user = user;
  next();
}
