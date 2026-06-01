import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "../../src/index.js";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";
import { seedMessage } from "../helpers/seed.js";
import { UPLOAD_DIR } from "../../src/storage.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

// owner + one extra member sharing a fresh channel.
async function setup() {
  const owner = await registerUser(app);
  const member = await registerUser(app);
  const ch = (await authed(app, owner.token).post("/channels").send({ name: "salon" })).body.channel;
  await authed(app, owner.token).post(`/channels/${ch.id}/members`).send({ userIds: [member.user.id] });
  return { owner, member, channelId: ch.id };
}

describe("GET /channels/:id/messages", () => {
  it("returns all delivered messages inline (roots + replies), each reply carrying its parent quote", async () => {
    const { owner, channelId } = await setup();
    const t0 = new Date(Date.now() - 3000);
    const t1 = new Date(Date.now() - 2000);
    const t2 = new Date(Date.now() - 1000);
    const first = await seedMessage({ channelId, authorId: owner.user.id, body: "premier", createdAt: t0 });
    await seedMessage({ channelId, authorId: owner.user.id, body: "second", createdAt: t1 });
    await seedMessage({ channelId, authorId: owner.user.id, body: "une réponse", parentId: first.id, createdAt: t2 });
    await seedMessage({ channelId, authorId: owner.user.id, body: "planifié", delivered: false, scheduledAt: new Date(Date.now() + 60000) });

    const res = await authed(app, owner.token).get(`/channels/${channelId}/messages`);
    expect(res.status).toBe(200);
    const bodies = res.body.messages.map((m) => m.body);
    // Inline timeline now includes replies; scheduled (not delivered) excluded.
    expect(bodies).toEqual(["premier", "second", "une réponse"]);

    // Reply carries a parent quote with author + decrypted body.
    const reply = res.body.messages.find((m) => m.body === "une réponse");
    expect(reply.parentId).toBe(first.id);
    expect(reply.parent).toMatchObject({ id: first.id, body: "premier" });
    expect(reply.parent.author.id).toBe(owner.user.id);

    // Root messages have no parent.
    const root = res.body.messages.find((m) => m.id === first.id);
    expect(root.parent).toBeNull();
  });

  it("rejects a non-member with 403", async () => {
    const { channelId } = await setup();
    const stranger = await registerUser(app);
    const res = await authed(app, stranger.token).get(`/channels/${channelId}/messages`);
    expect(res.status).toBe(403);
  });
});

describe("PATCH /channels/messages/:id (edit)", () => {
  it("lets the author edit and stamps editedAt", async () => {
    const { owner, channelId } = await setup();
    const msg = await seedMessage({ channelId, authorId: owner.user.id, body: "avant" });
    const res = await authed(app, owner.token)
      .patch(`/channels/messages/${msg.id}`)
      .send({ body: "après" });
    expect(res.status).toBe(200);
    expect(res.body.message.body).toBe("après");
    expect(res.body.message.editedAt).toBeTruthy();
  });

  it("keeps the parent quote hydrated when editing a reply (regression #44)", async () => {
    const { owner, channelId } = await setup();
    const parent = await seedMessage({ channelId, authorId: owner.user.id, body: "le parent" });
    const reply = await seedMessage({
      channelId, authorId: owner.user.id, body: "réponse", parentId: parent.id,
    });

    const res = await authed(app, owner.token)
      .patch(`/channels/messages/${reply.id}`)
      .send({ body: "réponse éditée" });

    expect(res.status).toBe(200);
    expect(res.body.message.body).toBe("réponse éditée");
    expect(res.body.message.parentId).toBe(parent.id);
    // The quote must survive the edit (it returned null before the include fix).
    expect(res.body.message.parent).toMatchObject({ id: parent.id, body: "le parent" });
    expect(res.body.message.parent.author.id).toBe(owner.user.id);
  });

  it("leaves parent null when editing a root message", async () => {
    const { owner, channelId } = await setup();
    const msg = await seedMessage({ channelId, authorId: owner.user.id, body: "racine" });
    const res = await authed(app, owner.token)
      .patch(`/channels/messages/${msg.id}`)
      .send({ body: "racine éditée" });
    expect(res.status).toBe(200);
    expect(res.body.message.parent).toBeNull();
  });

  it("rejects a non-author (404), empty body (400), and scheduled/unknown (404)", async () => {
    const { owner, member, channelId } = await setup();
    const msg = await seedMessage({ channelId, authorId: owner.user.id, body: "x" });
    expect(
      (await authed(app, member.token).patch(`/channels/messages/${msg.id}`).send({ body: "hack" })).status
    ).toBe(404);
    expect(
      (await authed(app, owner.token).patch(`/channels/messages/${msg.id}`).send({ body: "   " })).status
    ).toBe(400);

    const scheduled = await seedMessage({
      channelId, authorId: owner.user.id, body: "plus tard", delivered: false,
      scheduledAt: new Date(Date.now() + 60000),
    });
    expect(
      (await authed(app, owner.token).patch(`/channels/messages/${scheduled.id}`).send({ body: "y" })).status
    ).toBe(404);
    expect(
      (await authed(app, owner.token).patch(`/channels/messages/missing`).send({ body: "y" })).status
    ).toBe(404);
  });
});

describe("DELETE /channels/messages/:id", () => {
  it("lets the author delete and cascades replies", async () => {
    const { owner, channelId } = await setup();
    const parent = await seedMessage({ channelId, authorId: owner.user.id, body: "parent" });
    const reply = await seedMessage({ channelId, authorId: owner.user.id, body: "child", parentId: parent.id });

    const res = await authed(app, owner.token).delete(`/channels/messages/${parent.id}`);
    expect(res.status).toBe(200);
    expect(await prisma.message.findUnique({ where: { id: parent.id } })).toBeNull();
    expect(await prisma.message.findUnique({ where: { id: reply.id } })).toBeNull(); // cascade
  });

  it("rejects a non-author with 404", async () => {
    const { owner, member, channelId } = await setup();
    const msg = await seedMessage({ channelId, authorId: owner.user.id, body: "mine" });
    const res = await authed(app, member.token).delete(`/channels/messages/${msg.id}`);
    expect(res.status).toBe(404);
    expect(await prisma.message.findUnique({ where: { id: msg.id } })).not.toBeNull();
  });

  it("unlinks the on-disk blobs when the author deletes a message with attachments", async () => {
    const { owner, channelId } = await setup();
    const msg = await seedMessage({ channelId, authorId: owner.user.id, body: "with-pj" });

    // Stand-in for an upload: row + a real file in UPLOAD_DIR.
    const storagePath = "msg-delete-test.bin";
    const filePath = path.join(UPLOAD_DIR, storagePath);
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(filePath, "data");
    await prisma.attachment.create({
      data: {
        uploadedBy: owner.user.id,
        messageId: msg.id,
        filename: "file.txt",
        mimeType: "text/plain",
        size: 4,
        storagePath,
      },
    });

    const res = await authed(app, owner.token).delete(`/channels/messages/${msg.id}`);
    expect(res.status).toBe(200);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

// The dedicated /thread endpoint was removed when we moved to Discord-style
// inline replies (PR-threads). Replies now arrive in the timeline alongside
// roots, each carrying their `parent` quote — see the GET /messages test above.
