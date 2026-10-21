// Jeton de lecture porté par chaque Web Push de message.
//
// Android retient souvent un push jusqu'au déverrouillage (Doze) : il s'affiche
// alors des heures après, pour un message lu depuis longtemps sur un autre
// appareil. Le service worker n'a pas le JWT de l'utilisateur ; ce jeton lui
// permet de demander au serveur, au moment d'afficher, si ce message a été lu
// entre-temps (POST /auth/web-push/read-state). Signé (HMAC), il désigne UN
// message pour UN destinataire et ne donne accès qu'à ce booléen.
import crypto from "node:crypto";

export type ReadTokenClaims = {
  userId: string;
  channelId: string;
  /** Horodatage (ms) du message : il est lu si `lastReadAt >= createdAt`. */
  createdAt: number;
};

// Identifiants Prisma (cuid) : pas de point, qui sert de séparateur.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

// Clé dérivée du secret JWT (même repli que auth.ts) plutôt qu'un secret de
// plus à configurer ; le préfixe la rend distincte de la clé des JWT.
let key: Buffer | null = null;
function signingKey() {
  key ??= crypto
    .createHash("sha256")
    .update(`murgat-push-read:${process.env.JWT_SECRET || "dev-secret"}`)
    .digest();
  return key;
}

function mac(body: string) {
  // 128 bits suffisent pour un jeton qui n'ouvre qu'un booléen.
  return crypto.createHmac("sha256", signingKey()).update(body).digest("base64url").slice(0, 22);
}

export function signReadToken({ userId, channelId, createdAt }: ReadTokenClaims) {
  const body = Buffer.from(`${userId}.${channelId}.${Math.trunc(createdAt)}`).toString("base64url");
  return `${body}.${mac(body)}`;
}

/** Les revendications du jeton, ou null s'il est mal formé ou falsifié. */
export function verifyReadToken(token: unknown): ReadTokenClaims | null {
  if (typeof token !== "string" || token.length > 300) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = mac(body);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [userId, channelId, ts] = Buffer.from(body, "base64url").toString("utf8").split(".");
  const createdAt = Number(ts);
  if (!ID.test(userId ?? "") || !ID.test(channelId ?? "") || !Number.isFinite(createdAt)) {
    return null;
  }
  return { userId, channelId, createdAt };
}
