import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/index.js";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";
import { seedMessage } from "../helpers/seed.js";

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
  it("returns only delivered roots (decrypted, ordered), with replyCount", async () => {
    const { owner, channelId } = await setup();
    const t0 = new Date(Date.now() - 3000);
    const t1 = new Date(Date.now() - 2000);
    const first = await seedMessage({ channelId, authorId: owner.user.id, body: "premier", createdAt: t0 });
    await seedMessage({ channelId, authorId: owner.user.id, body: "second", createdAt: t1 });
    await seedMessage({ channelId, authorId: owner.user.id, body: "une réponse", parentId: first.id });
    await seedMessage({ channelId, authorId: owner.user.id, body: "planifié", delivered: false, scheduledAt: new Date(Date.now() + 60000) });

    const res = await authed(app, owner.token).get(`/channels/${channelId}/messages`);
    expect(res.status).toBe(200);
    const bodies = res.body.messages.map((m) => m.body);
    expect(bodies).toEqual(["premier", "second"]); // roots only, ordered, no reply/scheduled
    const root = res.body.messages.find((m) => m.id === first.id);
    expect(root.replyCount).toBe(1);
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
});

describe("GET /channels/messages/:id/thread", () => {
  it("returns the parent and its delivered replies in order", async () => {
    const { owner, channelId } = await setup();
    const parent = await seedMessage({ channelId, authorId: owner.user.id, body: "racine" });
    await seedMessage({ channelId, authorId: owner.user.id, body: "r1", parentId: parent.id, createdAt: new Date(Date.now() - 2000) });
    await seedMessage({ channelId, authorId: owner.user.id, body: "r2", parentId: parent.id, createdAt: new Date(Date.now() - 1000) });

    const res = await authed(app, owner.token).get(`/channels/messages/${parent.id}/thread`);
    expect(res.status).toBe(200);
    expect(res.body.parent.id).toBe(parent.id);
    expect(res.body.replies.map((r) => r.body)).toEqual(["r1", "r2"]);
  });

  it("404 for unknown parent, 403 for non-member", async () => {
    const { owner, channelId } = await setup();
    const parent = await seedMessage({ channelId, authorId: owner.user.id, body: "racine" });
    expect((await authed(app, owner.token).get(`/channels/messages/missing/thread`)).status).toBe(404);
    const stranger = await registerUser(app);
    expect(
      (await authed(app, stranger.token).get(`/channels/messages/${parent.id}/thread`)).status
    ).toBe(403);
  });
});
