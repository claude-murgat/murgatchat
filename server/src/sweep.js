import { prisma } from "./db.js";
import { listStoredFiles, safeUnlink, fileAgeMs } from "./storage.js";

// Twin guardrails against orphans:
//   (a) blobs on disk with no matching Attachment row — typically because
//       a cascade delete fired but the synchronous file unlink failed, or
//       because something wrote the file outside of our flow.
//   (b) Attachment rows that never got attached to a Message (`messageId` is
//       null) and have been sitting around for a long time — the user uploaded
//       a file but never sent the message.
// Files younger than ORPHAN_GRACE_MS are left alone so we never race a real
// upload that just got its blob written but hasn't created its row yet.
const ORPHAN_GRACE_MS = 60 * 60 * 1000; // 1h
const UNATTACHED_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export async function sweepOrphanAttachments({
  now = Date.now(),
  orphanGraceMs = ORPHAN_GRACE_MS,
  unattachedTtlMs = UNATTACHED_TTL_MS,
} = {}) {
  let filesDeleted = 0;
  let rowsDeleted = 0;

  // (a) Blobs without an Attachment row, older than the grace window.
  const stored = await listStoredFiles();
  if (stored.length) {
    const known = new Set(
      (
        await prisma.attachment.findMany({
          where: { storagePath: { in: stored } },
          select: { storagePath: true },
        })
      ).map((a) => a.storagePath)
    );
    for (const filename of stored) {
      if (known.has(filename)) continue;
      const ageMs = await fileAgeMs(filename, { now });
      if (ageMs < 0 || ageMs < orphanGraceMs) continue;
      if (await safeUnlink(filename)) filesDeleted += 1;
    }
  }

  // (b) Abandoned uploads: Attachment row created, never attached, old enough.
  const cutoff = new Date(now - unattachedTtlMs);
  const unattached = await prisma.attachment.findMany({
    where: { messageId: null, createdAt: { lt: cutoff } },
  });
  if (unattached.length) {
    await Promise.all(unattached.map((a) => safeUnlink(a.storagePath)));
    const r = await prisma.attachment.deleteMany({
      where: { id: { in: unattached.map((a) => a.id) } },
    });
    rowsDeleted = r.count;
  }

  return { filesDeleted, rowsDeleted };
}
