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

router.post("/", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no_file" });
  const filename = Buffer.from(req.file.originalname, "latin1").toString("utf8");
  const ext = path.extname(req.file.originalname).slice(0, 20);
  const storageName = crypto.randomBytes(16).toString("hex") + ext;
  const finalPath = path.join(UPLOAD_DIR, storageName);

  try {
    await encryptBufferToFile(req.file.buffer, finalPath);
  } catch (e) {
    console.error("[uploads] encrypt failed:", e.message);
    // Best-effort cleanup: a partial blob would otherwise hang around until the sweep.
    try { await fs.promises.unlink(finalPath); } catch { /* nothing to clean */ }
    return res.status(500).json({ error: "encrypt_failed" });
  }

  const att = await prisma.attachment.create({
    data: {
      uploadedBy: req.userId,
      filename,
      mimeType: req.file.mimetype || "application/octet-stream",
      size: req.file.size, // plaintext size; the blob on disk is larger
      storagePath: storageName,
      encrypted: true,
    },
  });
  res.json({
    attachment: {
      id: att.id,
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.size,
    },
  });
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

  res.setHeader("Content-Type", att.mimeType);
  res.setHeader("Content-Length", String(att.size));
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(att.filename)}`
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
