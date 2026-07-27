import crypto from "node:crypto";
import fs from "node:fs";

// Same key as the body encryption (server/src/crypto.js): one secret to rotate,
// one secret to back up. AES-256-GCM in both cases.
const RAW = process.env.MESSAGE_ENCRYPTION_KEY || "";
let KEY;
if (RAW && /^[0-9a-fA-F]{64}$/.test(RAW)) {
  KEY = Buffer.from(RAW, "hex");
} else {
  KEY = crypto
    .createHash("sha256")
    .update(RAW || "dev-only-key-change-in-prod")
    .digest();
}

// On-disk layout for an encrypted blob:
//   byte 0      : VERSION (room for future format bumps)
//   bytes 1..12 : random IV (96-bit, recommended for GCM)
//   bytes 13..N : ciphertext
//   bytes N+1.. : 16-byte GCM auth tag
// Older blobs (pre-v0.5) have `Attachment.encrypted=false` and are served raw.
export const BLOB_VERSION = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES;

// In-memory encrypt: writes [version][iv][ciphertext][tag] to destPath atomically.
// We use writeFile rather than a streaming pipeline because the upload cap is
// already 25 MiB — buffering is safer (atomic, no partial blob on crash) and
// the RAM cost is negligible relative to the request handler footprint.
export async function encryptBufferToFile(plaintextBuf, destPath) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([Buffer.from([BLOB_VERSION]), iv, ct, tag]);
  await fs.promises.writeFile(destPath, blob);
  return blob.length;
}

// Read + parse + verify in one go. Throws on bad version, truncated blob, or
// failed GCM tag verification — the caller decides whether to 404 or 500.
export async function decryptFile(srcPath) {
  const buf = await fs.promises.readFile(srcPath);
  if (buf.length < HEADER_BYTES + TAG_BYTES) throw new Error("blob_too_short");
  if (buf[0] !== BLOB_VERSION) throw new Error("unknown_blob_version");
  const iv = buf.subarray(1, HEADER_BYTES);
  const ct = buf.subarray(HEADER_BYTES, buf.length - TAG_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
