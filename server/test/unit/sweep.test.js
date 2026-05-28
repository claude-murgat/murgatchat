import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sweepOrphanAttachments } from "../../src/sweep.js";
import { UPLOAD_DIR } from "../../src/storage.js";
import { prisma } from "../helpers/db.js";
import { registerUser } from "../helpers/api.js";
import { createServer } from "../../src/index.js";

const { app } = createServer();

function touch(filename, ageMs = 0) {
  const p = path.join(UPLOAD_DIR, filename);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(p, "stub");
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(p, t, t);
  }
  return p;
}

beforeEach(() => {
  // The UPLOAD_DIR is shared across tests; wipe it so each test starts clean.
  if (fs.existsSync(UPLOAD_DIR)) {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      fs.unlinkSync(path.join(UPLOAD_DIR, f));
    }
  }
});

describe("sweepOrphanAttachments", () => {
  it("leaves recent orphan blobs alone (grace window)", async () => {
    touch("recent-orphan.bin"); // fresh -> still within the grace window
    const { filesDeleted } = await sweepOrphanAttachments();
    expect(filesDeleted).toBe(0);
    expect(fs.existsSync(path.join(UPLOAD_DIR, "recent-orphan.bin"))).toBe(true);
  });

  it("deletes a blob with no Attachment row once past the grace window", async () => {
    touch("stale-orphan.bin", 2 * 60 * 60 * 1000); // 2h old
    const { filesDeleted } = await sweepOrphanAttachments();
    expect(filesDeleted).toBe(1);
    expect(fs.existsSync(path.join(UPLOAD_DIR, "stale-orphan.bin"))).toBe(false);
  });

  it("preserves blobs that have a matching Attachment row, regardless of age", async () => {
    const { user } = await registerUser(app);
    const path1 = touch("kept.bin", 7 * 24 * 60 * 60 * 1000); // 7 days old
    await prisma.attachment.create({
      data: {
        uploadedBy: user.id,
        filename: "kept.txt",
        mimeType: "text/plain",
        size: 4,
        storagePath: "kept.bin",
      },
    });
    const { filesDeleted } = await sweepOrphanAttachments();
    expect(filesDeleted).toBe(0);
    expect(fs.existsSync(path1)).toBe(true);
  });

  it("deletes abandoned Attachment rows (messageId=null) older than the TTL", async () => {
    const { user } = await registerUser(app);
    const old = await prisma.attachment.create({
      data: {
        uploadedBy: user.id,
        filename: "abandoned.txt",
        mimeType: "text/plain",
        size: 5,
        storagePath: "abandoned.bin",
        // Backdate manually past the 24h TTL.
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    });
    touch("abandoned.bin", 25 * 60 * 60 * 1000);

    const fresh = await prisma.attachment.create({
      data: {
        uploadedBy: user.id,
        filename: "fresh.txt",
        mimeType: "text/plain",
        size: 5,
        storagePath: "fresh.bin",
      },
    });
    touch("fresh.bin");

    const { filesDeleted, rowsDeleted } = await sweepOrphanAttachments();
    // The stale row's blob is unlinked AND the row is gone; the fresh one stays.
    expect(rowsDeleted).toBe(1);
    expect(filesDeleted).toBe(0); // counted under rowsDeleted, not filesDeleted
    expect(await prisma.attachment.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.attachment.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    expect(fs.existsSync(path.join(UPLOAD_DIR, "abandoned.bin"))).toBe(false);
    expect(fs.existsSync(path.join(UPLOAD_DIR, "fresh.bin"))).toBe(true);
  });

  it("ignores stored files attached to a delivered message even when old", async () => {
    const { user } = await registerUser(app);
    const channel = await prisma.channel.create({
      data: { name: "C", isDirect: false },
    });
    await prisma.membership.create({
      data: { userId: user.id, channelId: channel.id },
    });
    const msg = await prisma.message.create({
      data: {
        channelId: channel.id,
        authorId: user.id,
        body: "with-attachment",
        delivered: true,
      },
    });
    await prisma.attachment.create({
      data: {
        uploadedBy: user.id,
        messageId: msg.id,
        filename: "kept.txt",
        mimeType: "text/plain",
        size: 4,
        storagePath: "attached.bin",
      },
    });
    touch("attached.bin", 30 * 24 * 60 * 60 * 1000); // 30 days old
    const { filesDeleted, rowsDeleted } = await sweepOrphanAttachments();
    expect(filesDeleted).toBe(0);
    expect(rowsDeleted).toBe(0);
    expect(fs.existsSync(path.join(UPLOAD_DIR, "attached.bin"))).toBe(true);
  });
});
