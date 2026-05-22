import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/index.js";
import { registerUser, authed } from "../helpers/api.js";
import { seedMessage } from "../helpers/seed.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

async function setup() {
  const owner = await registerUser(app);
  const member = await registerUser(app);
  const ch = (await authed(app, owner.token).post("/channels").send({ name: "reacts" })).body.channel;
  await authed(app, owner.token).post(`/channels/${ch.id}/members`).send({ userIds: [member.user.id] });
  const msg = await seedMessage({ channelId: ch.id, authorId: owner.user.id, body: "réagissez" });
  return { owner, member, channelId: ch.id, msg };
}

const react = (token, id, emoji) =>
  authed(app, token).post(`/channels/messages/${id}/reactions`).send({ emoji });

describe("POST /channels/messages/:id/reactions", () => {
  it("toggles a reaction on and off", async () => {
    const { member, msg } = await setup();

    const on = await react(member.token, msg.id, "👍");
    expect(on.status).toBe(200);
    const group = on.body.reactions.find((r) => r.emoji === "👍");
    expect(group.count).toBe(1);
    expect(group.users.map((u) => u.id)).toContain(member.user.id);

    const off = await react(member.token, msg.id, "👍");
    expect(off.body.reactions.find((r) => r.emoji === "👍")).toBeUndefined();
  });

  it("aggregates the same emoji across users", async () => {
    const { owner, member, msg } = await setup();
    await react(owner.token, msg.id, "🎉");
    const res = await react(member.token, msg.id, "🎉");
    const group = res.body.reactions.find((r) => r.emoji === "🎉");
    expect(group.count).toBe(2);
    expect(group.users.map((u) => u.id).sort()).toEqual([owner.user.id, member.user.id].sort());
  });

  it("rejects invalid emoji (400), unknown message (404), non-member (403)", async () => {
    const { owner, msg, channelId } = await setup();
    expect((await react(owner.token, msg.id, "")).status).toBe(400);
    expect((await react(owner.token, msg.id, "x".repeat(33))).status).toBe(400);
    expect((await react(owner.token, "missing", "👍")).status).toBe(404);

    const stranger = await registerUser(app);
    expect((await react(stranger.token, msg.id, "👍")).status).toBe(403);
    expect(channelId).toBeTruthy();
  });
});
