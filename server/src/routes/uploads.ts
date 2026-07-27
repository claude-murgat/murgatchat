import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "../db.ts";
import { requireAuth, verifyToken } from "../auth.ts";
import { encryptBufferToFile, decryptFile } from "../cryptoFile.ts";

const UPLOAD_DIR = process.env.UPLOAD_DIR || "/data/uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Taille maximale d'une pièce jointe. Configurable via l'env MAX_UPLOAD_MB
// (défaut 50 Mo), borné à >= 1 Mo. Exporté pour que la route GIF
// (routes/gifs.js) reflète la même limite et que la réponse d'erreur puisse
// annoncer le plafond au client.
const MAX_UPLOAD_MB = Math.max(1, Math.floor(Number(process.env.MAX_UPLOAD_MB) || 50));
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// Memory storage so the upload never touches disk until it's been encrypted.
// La RAM par upload en cours = la taille du fichier ; le plafond ci-dessus la borne.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// Enveloppe multer : traduit un dépassement de taille en 413 explicite (avec le
// plafond, pour l'UI) au lieu du 500 générique du handler d'erreur par défaut.
function uploadSingle(req: Request, res: Response, next: NextFunction) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "file_too_large", maxMb: MAX_UPLOAD_MB });
    }
    console.error("[uploads] multer error:", err.message);
    return res.status(400).json({ error: "upload_failed" });
  });
}

const router = Router();

// How many files a single bug report / support ticket may carry (issue #96).
// Small on purpose: screenshots + a log file, not a dumping ground.
export const MAX_ATTACHMENTS = 3;

// Load the attachments a user is allowed to tie to a bug report or support
// conversation: their own, and not already bound to a chat message or another
// report. Returns the (deduped, capped) metadata rows; the caller then points
// them at the target via prisma.attachment.updateMany. Filtering by ownership
// here is the guard that stops a client from attaching someone else's upload by
// guessing its id.
export async function ownedUnlinkedAttachments(
  // `unknown[]` et pas `string[]` : les ids viennent du client, le filtre
  // `typeof s === "string"` ci-dessous est la garde d'exécution correspondante.
  ids: readonly unknown[] | null | undefined,
  uploadedBy: string
) {
  const unique = [...new Set((ids || []).filter((s) => typeof s === "string"))].slice(
    0,
    MAX_ATTACHMENTS
  );
  if (!unique.length) return [];
  return prisma.attachment.findMany({
    where: { id: { in: unique }, uploadedBy, messageId: null, bugReportId: null },
    select: { id: true, filename: true, mimeType: true, size: true },
  });
}

// Encrypt a buffer to disk and create its Attachment row. Shared by the file
// upload route and the GIF import route (routes/gifs.js) so both go through the
// same AES-256-GCM-at-rest path. `size` is the plaintext length; the on-disk
// blob is larger (header + tag). Cleans up the partial blob if encryption throws.
export async function storeEncryptedAttachment(
  buffer: Buffer,
  {
    filename,
    mimeType,
    uploadedBy,
  }: { filename?: string | null; mimeType?: string | null; uploadedBy: string }
) {
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

router.post("/", requireAuth, uploadSingle, async (req, res) => {
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
    console.error("[uploads] store failed:", e instanceof Error ? e.message : e);
    res.status(500).json({ error: "encrypt_failed" });
  }
});

router.get("/:id", async (req, res) => {
  const token =
    (req.headers.authorization || "").replace(/^Bearer /, "") ||
    (req.query.token as string | undefined);
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: "unauthorized" });
  // `sub` d'un JWT est typé `string | undefined` (et `String.prototype.sub` si le
  // payload est une chaîne) : nos tokens y mettent toujours l'id utilisateur.
  const userId = payload.sub as string;

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
  // Bug-report screenshots (issue #96): the reporter (uploader) always sees them;
  // the team reaches them through the admin backlog, so any admin may fetch one
  // that is tied to a report. Scoped to bug-report attachments — chat/DM files
  // (no bugReportId) are untouched, so this doesn't widen access to private chats.
  let isReportAdmin = false;
  if (!isUploader && !isMember && att.bugReportId) {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true },
    });
    isReportAdmin = Boolean(u?.isAdmin);
  }
  if (!isUploader && !isMember && !isReportAdmin) {
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
    // Buffered decrypt: the upload cap bounds RAM cost; in exchange we can fail
    // cleanly (and skip writing partial bytes) if the GCM tag is bad.
    try {
      const plaintext = await decryptFile(filePath);
      res.end(plaintext);
    } catch (e) {
      console.error("[uploads] decrypt failed:", e instanceof Error ? e.message : e);
      res.status(500).json({ error: "decrypt_failed" });
    }
  } else {
    // Legacy blob (pre-encryption rollout): serve raw.
    fs.createReadStream(filePath).pipe(res);
  }
});

export default router;
