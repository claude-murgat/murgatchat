import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "../db.ts";
import { requireAuth, authenticate } from "../auth.ts";
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

// Local admin gate — same one-liner as routes/auth.ts and routes/bugReports.ts,
// duplicated to keep the routers decoupled.
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: "admin_required" });
  next();
}

// Onglet « Stockage » de l'administration : place du disque qui porte
// UPLOAD_DIR, volume des pièces jointes par type et plus gros fichiers. Déclarée
// avant GET /:id, qui prendrait sinon « storage » pour un identifiant.
router.get("/storage", requireAuth, requireAdmin, async (req, res) => {
  const [disk, types, largest] = await Promise.all([
    fs.promises.statfs(UPLOAD_DIR),
    // Par type MIME *et* extension : le client classe chaque groupe avec
    // fileIcon(), qui se rabat sur l'extension quand le MIME est générique.
    prisma.$queryRaw<{ mimeType: string; ext: string | null; count: number; bytes: number }[]>`
      SELECT "mimeType", lower(substring(filename from '[.]([A-Za-z0-9]+)$')) AS ext,
             count(*)::int AS count, sum(size)::float8 AS bytes
      FROM "Attachment" GROUP BY 1, 2`,
    prisma.attachment.findMany({
      orderBy: { size: "desc" },
      take: 10,
      include: {
        message: {
          select: {
            channel: {
              select: {
                name: true,
                isDirect: true,
                isPrivate: true,
                memberships: { where: { userId: req.userId }, select: { id: true } },
              },
            },
          },
        },
      },
    }),
  ]);

  res.json({
    disk: { total: disk.blocks * disk.bsize, available: disk.bavail * disk.bsize },
    types,
    largest: largest.map((a) => {
      const ch = a.message?.channel;
      // Ni nom de fichier ni nom de salon pour une conversation privée (salon
      // privé, DM, expert Claude) dont l'admin n'est pas membre, ni pour un
      // envoi pas encore posté : seuls le type, la taille et la date sortent.
      const visible = ch
        ? ch.memberships.length > 0 || (!ch.isPrivate && !ch.isDirect)
        : Boolean(a.bugReportId);
      let place = a.bugReportId ? "Rapport de bug" : "Non envoyé";
      if (ch && !visible) place = "Conversation privée";
      else if (ch) place = ch.isDirect || !ch.name ? "Message direct" : `#${ch.name}`;
      return {
        id: a.id,
        filename: visible ? a.filename : null,
        mimeType: a.mimeType,
        size: a.size,
        createdAt: a.createdAt,
        place,
      };
    }),
  });
});

router.get("/:id", async (req, res) => {
  const token =
    (req.headers.authorization || "").replace(/^Bearer /, "") ||
    (req.query.token as string | undefined);
  // Même contrôle que requireAuth (compte désactivé refusé), le jeton pouvant
  // aussi venir de la query (`<img src>` ne sait pas poser d'en-tête).
  const user = await authenticate(token);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const userId = user.id;

  const att = await prisma.attachment.findUnique({
    where: { id: req.params.id },
    include: {
      message: {
        include: {
          channel: { include: { memberships: { where: { userId }, select: { id: true } } } },
        },
      },
    },
  });
  if (!att) return res.status(404).json({ error: "not_found" });

  // A file posted in a conversation belongs to that conversation: members only,
  // its uploader included — once removed from a private channel, no more access.
  // Bug-report screenshots (issue #96): the reporter (uploader) always sees them;
  // the team reaches them through the admin backlog, so any admin may fetch one
  // that is tied to a report. Not yet sent (composer) or tied to a support
  // ticket: the uploader only.
  const allowed = att.message
    ? att.message.channel.memberships.length > 0
    : att.uploadedBy === userId || (Boolean(att.bugReportId) && user.isAdmin);
  if (!allowed) {
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
