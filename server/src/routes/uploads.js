import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "../db.js";
import { requireAuth, verifyToken } from "../auth.js";
import { encryptBufferToFile, decryptFile } from "../cryptoFile.js";

const UPLOAD_DIR = process.env.UPLOAD_DIR || "/data/uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Memory storage so the upload never touches disk until it's been encrypted.
// 25 MiB cap stays in line with the previous behavior.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const router = Router();

// Encrypt a buffer to disk and create its Attachment row. Shared by the file
// upload route and the GIF import route (routes/gifs.js) so both go through the
// same AES-256-GCM-at-rest path. `size` is the plaintext length; the on-disk
// blob is larger (header + tag). Cleans up the partial blob if encryption throws.
export async function storeEncryptedAttachment(buffer, { filename, mimeType, uploadedBy }) {
  const safeName = filename || "fichier";
  const ext = path.extname(safeName).slice(0, 20);
  const storageName = crypto.randomBytes(16).toString("hex") + ext;
  const finalPath = path.join(UPLOAD_DIR, storageName);
  try {
    await encryptBufferToFile(buffer, finalPath);
  } catch (e) {
    try { await fs.promises.unlink(finalPath); } catch { /* nothing to clean */ }
    throw e;
  }
  return prisma.attachment.create({
    data: {
      uploadedBy,
      filename: safeName,
      mimeType: mimeType || "application/octet-stream",
      size: buffer.length,
      storagePath: storageName,
      encrypted: true,
    },
  });
}

router.post("/", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no_file" });
  const filename = Buffer.from(req.file.originalname, "latin1").toString("utf8");
  try {
    const att = await storeEncryptedAttachment(req.file.buffer, {
      filename,
      mimeType: req.file.mimetype,
      uploadedBy: req.userId,
    });
    res.json({
      attachment: { id: att.id, filename: att.filename, mimeType: att.mimeType, size: att.size },
    });
  } catch (e) {
    console.error("[uploads] store failed:", e.message);
    res.status(500).json({ error: "encrypt_failed" });
  }
});

router.get("/:id", async (req, res) => {
  const token =
    (req.headers.authorization || "").replace(/^Bearer /, "") ||
    req.query.token;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: "unauthorized" });
  const userId = payload.sub;

  const att = await prisma.attachment.findUnique({
    where: { id: req.params.id },
    include: {
      message: {
        include: { channel: { include: { memberships: true } } },
      },
    },
  });
  if (!att) return res.status(404).json({ error: "not_found" });

  const isUploader = att.uploadedBy === userId;
  const isMember =
    att.message?.channel?.memberships?.some((m) => m.userId === userId);
  if (!isUploader && !isMember) {
    return res.status(403).json({ error: "forbidden" });
  }

  const filePath = path.join(UPLOAD_DIR, att.storagePath);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "missing_file" });
  }

  // `?download=1` forces a download (attachment) instead of inline rendering.
  // The web client uses it for its "Télécharger" button so the browser saves the
  // file with its real name rather than navigating to it; the preview path leaves
  // it off so <img>/<video>/<iframe> can render the bytes in place.
  const disposition = req.query.download ? "attachment" : "inline";
  res.setHeader("Content-Type", att.mimeType);
  res.setHeader("Content-Length", String(att.size));
  res.setHeader(
    "Content-Disposition",
    `${disposition}; filename*=UTF-8''${encodeURIComponent(att.filename)}`
  );

  if (att.encrypted) {
    // Buffered decrypt: cap is 25 MiB, so RAM cost is bounded; in exchange we
    // can fail cleanly (and skip writing partial bytes) if the GCM tag is bad.
    try {
      const plaintext = await decryptFile(filePath);
      res.end(plaintext);
    } catch (e) {
      console.error("[uploads] decrypt failed:", e.message);
      res.status(500).json({ error: "decrypt_failed" });
    }
  } else {
    // Legacy blob (pre-encryption rollout): serve raw.
    fs.createReadStream(filePath).pipe(res);
  }
});

export default router;
