import jwt from "jsonwebtoken";
import type { JwtPayload } from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import type { User } from "@prisma/client";
import { prisma } from "./db.ts";

const SECRET = process.env.JWT_SECRET || "dev-secret";

/** Charge utile de nos JWT, telle qu'écrite par `signToken`. */
export interface AuthTokenPayload extends JwtPayload {
  sub: string;
  email: string;
  username: string;
}

export function signToken(user: Pick<User, "id" | "email" | "username">) {
  return jwt.sign(
    { sub: user.id, email: user.email, username: user.username },
    SECRET,
    { expiresIn: "30d" }
  );
}

// `token` est déclaré `unknown` et non `string` parce que les appelants le
// tirent de sources non fiables (en-tête HTTP, `req.query`, handshake
// Socket.IO) : la fonction est totale, toute entrée invalide retombe dans le
// `catch` et rend `null`.
export function verifyToken(token: unknown): AuthTokenPayload | null {
  try {
    // Cast requis par la signature de `jwt.verify` (qui exige une string) ;
    // un non-string y lève, ce qui est déjà le comportement d'origine.
    return jwt.verify(token as string, SECRET) as AuthTokenPayload;
  } catch {
    return null;
  }
}

// Loads the user from DB so that a soft-deleted account (`status='disabled'`)
// is rejected immediately, even with a still-valid JWT. The user row is exposed
// as `req.user` so admin middlewares don't have to re-fetch.
// ⚠ `req` est générique sur les PARAMÈTRES de route (`P`) : ce middleware ne lit
// jamais `req.params`, et l'annoter avec le `Request` par défaut figerait `P` sur
// `ParamsDictionary` pour TOUTES les routes qui le montent — `req.params.id`
// retomberait alors sur `string | string[]` au lieu du `{ id: string }` déduit du
// chemin, cassant une quarantaine d'appels Prisma en aval.
export async function requireAuth<P>(
  req: Request<P>,
  res: Response,
  next: NextFunction
) {
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
