import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "../db.js";
import { requireAuth, verifyToken } from "../auth.js";

const UPLOAD_DIR = process.env.UPLOAD_DIR || "/data/uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 20);
    cb(null, crypto.randomBytes(16).toString("hex") + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
});

const router = Router();

router.post("/", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no_file" });
  const filename = Buffer.from(req.file.originalname, "latin1").toString("utf8");
  const att = await prisma.attachment.create({
    data: {
      uploadedBy: req.userId,
      filename,
      mimeType: req.file.mimetype || "application/octet-stream",
      size: req.file.size,
      storagePath: req.file.filename,
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
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(att.filename)}`
  );
  fs.createReadStream(filePath).pipe(res);
});

export default router;
