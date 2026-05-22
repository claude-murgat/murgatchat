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

async function setup() {
  const owner = await registerUser(app);
  const member = await registerUser(app);
  const ch = (await authed(app, owner.token).post("/channels").send({ name: "lu" })).body.channel;
  await authed(app, owner.token).post(`/channels/${ch.id}/members`).send({ userIds: [member.user.id] });
  return { owner, member, channelId: ch.id };
}

const setRead = (channelId, userId, when) =>
  prisma.membership.update({
    where: { userId_channelId: { userId, channelId } },
    data: { lastReadAt: when },
  });

const channelFor = async (token, channelId) => {
  const list = await authed(app, token).get("/channels");
  return list.body.channels.find((c) => c.id === channelId);
};

describe("unread flag in GET /channels", () => {
  it("is true when another author posted after lastReadAt", async () => {
    const { owner, member, channelId } = await setup();
    await setRead(channelId, member.user.id, new Date(Date.now() - 10000));
    await seedMessage({ channelId, authorId: owner.user.id, body: "coucou", createdAt: new Date(Date.now() - 5000) });

    const ch = await channelFor(member.token, channelId);
    expect(ch.unread).toBe(true);
  });

  it("is false for the viewer's own last message", async () => {
    const { member, channelId } = await setup();
    await setRead(channelId, member.user.id, new Date(Date.now() - 10000));
    await seedMessage({ channelId, authorId: member.user.id, body: "mon message", createdAt: new Date(Date.now() - 5000) });

    const ch = await channelFor(member.token, channelId);
    expect(ch.unread).toBe(false);
  });

  it("is false once lastReadAt is after the last message", async () => {
    const { owner, member, channelId } = await setup();
    await seedMessage({ channelId, authorId: owner.user.id, body: "vieux", createdAt: new Date(Date.now() - 10000) });
    await setRead(channelId, member.user.id, new Date());

    const ch = await channelFor(member.token, channelId);
    expect(ch.unread).toBe(false);
  });
});
