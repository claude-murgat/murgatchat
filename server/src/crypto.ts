import crypto from "node:crypto";

const RAW = process.env.MESSAGE_ENCRYPTION_KEY || "";
let KEY: Buffer;

if (RAW && /^[0-9a-fA-F]{64}$/.test(RAW)) {
  KEY = Buffer.from(RAW, "hex");
} else {
  KEY = crypto
    .createHash("sha256")
    .update(RAW || "dev-only-key-change-in-prod")
    .digest();
  if (!process.env.MESSAGE_ENCRYPTION_KEY) {
    console.warn(
      "[crypto] MESSAGE_ENCRYPTION_KEY not set; using derived dev key. DO NOT USE IN PROD."
    );
  }
}

const PREFIX = "enc1:";

// `plain` reste `unknown` : la coercition ci-dessous accepte délibérément
// n'importe quelle valeur (les appelants passent des strings, mais la fonction
// ne le suppose pas).
export function encryptBody(plain: unknown): string {
  const text = typeof plain === "string" ? plain : String(plain ?? "");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

// `Message.body` est un `String` non nul côté Prisma : tous les appelants
// passent bien une string. Les deux gardes ci-dessous restent en place pour les
// lignes historiques non chiffrées.
export function decryptBody(stored: string): string {
  if (typeof stored !== "string") return stored;
  if (!stored.startsWith(PREFIX)) return stored;
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch (e) {
    console.error("[crypto] decrypt failed:", e instanceof Error ? e.message : e);
    return "[message non déchiffrable]";
  }
}
