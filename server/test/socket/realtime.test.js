import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  startTestServer,
  connectSocket,
  newSocket,
  waitConnect,
  waitForEvent,
  expectNoEvent,
  waitInRoom,
} from "../helpers/server.js";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";

let srv;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});

// Disconnect any sockets opened during a test.
const open = [];
const track = (s) => {
  open.push(s);
  return s;
};
afterEach(() => {
  for (const s of open) s.disconnect();
  open.length = 0;
});

// Connect AND wait until the server has fully set the socket up (joined to the
// channel room), so immediate emits don't race the async connection handler.
async function ready(token, channelId, platform = "web") {
  const s = track(await connectSocket(srv.url, token, platform));
  await waitInRoom(srv.io, channelId, s.id);
  return s;
}

// alice (owner) + bob, both members of a fresh channel.
async function pairInChannel() {
  const alice = await registerUser(srv.app);
  const bob = await registerUser(srv.app);
  const ch = (await authed(srv.app, alice.token).post("/channels").send({ name: "rt" })).body.channel;
  await authed(srv.app, alice.token).post(`/channels/${ch.id}/members`).send({ userIds: [bob.user.id] });
  return { alice, bob, channelId: ch.id };
}

// Emit message:send and resolve with the server ack.
const send = (socket, payload) =>
  new Promise((resolve) => socket.emit("message:send", payload, resolve));

describe("socket auth handshake", () => {
  it("rejects a connection without a valid token", async () => {
    await expect(connectSocket(srv.url, "not-a-token")).rejects.toBeTruthy();
  });
});

describe("message:send", () => {
  it("broadcasts message:new to the channel and acks the sender", async () => {
    const { alice, bob, channelId } = await pairInChannel();
    const aSock = await ready(alice.token, channelId);
    const bSock = await ready(bob.token, channelId);

    const incoming = waitForEvent(bSock, "message:new", (m) => m.channelId === channelId);
    const ack = await send(aSock, { channelId, body: "salut bob" });
    expect(ack.ok).toBe(true);
    expect(ack.message.body).toBe("salut bob");

    const msg = await incoming;
    expect(msg.body).toBe("salut bob");
    expect(msg.author.id).toBe(alice.user.id);
  });

  it("emits message:new for a reply too, carrying the parent quote inline", async () => {
    const { alice, bob, channelId } = await pairInChannel();
    const aSock = await ready(alice.token, channelId);
    const bSock = await ready(bob.token, channelId);

    const root = await send(aSock, { channelId, body: "racine" });
    // Discord/Messenger model: replies share the timeline with root messages,
    // so they go out as `message:new` (not the old `thread:reply` channel).
    const replyEvent = waitForEvent(bSock, "message:new", (m) => m.parentId === root.message.id);
    const ack = await send(aSock, { channelId, body: "réponse", parentId: root.message.id });
    expect(ack.ok).toBe(true);
    const reply = await replyEvent;
    expect(reply.parentId).toBe(root.message.id);
    expect(reply.parent).toMatchObject({ id: root.message.id, body: "racine" });
    expect(reply.parent.author.id).toBe(alice.user.id);
  });

  it("allows replying to a reply (Discord-style, quote stays one level deep)", async () => {
    const { alice, bob, channelId } = await pairInChannel();
    const aSock = await ready(alice.token, channelId);
    const bSock = await ready(bob.token, channelId);

    const root = await send(aSock, { channelId, body: "racine" });
    const reply = await send(aSock, {
      channelId,
      body: "première réponse",
      parentId: root.message.id,
    });
    expect(reply.ok).toBe(true);

    // Reply to the reply — used to be rejected with invalid_parent under the
    // old Slack-thread rule; now accepted.
    const evt = waitForEvent(bSock, "message:new", (m) => m.body === "réponse à la réponse");
    const ack = await send(aSock, {
      channelId,
      body: "réponse à la réponse",
      parentId: reply.message.id,
    });
    expect(ack.ok).toBe(true);
    const grandReply = await evt;
    // The quote points at the cited reply itself (one level), not the root.
    expect(grandReply.parentId).toBe(reply.message.id);
    expect(grandReply.parent).toMatchObject({ id: reply.message.id, body: "première réponse" });
  });

  it("still rejects a parent from another channel (invalid_parent)", async () => {
    const { alice, bob, channelId } = await pairInChannel();
    const other = await pairInChannel();
    const aSock = await ready(alice.token, channelId);
    await ready(bob.token, channelId);

    const foreign = await send(
      await ready(other.alice.token, other.channelId),
      { channelId: other.channelId, body: "ailleurs" }
    );
    const ack = await send(aSock, {
      channelId,
      body: "réponse cross-channel",
      parentId: foreign.message.id,
    });
    expect(ack.error).toBe("invalid_parent");
  });

  it("acks a scheduled message without broadcasting message:new", async () => {
    const { alice, bob, channelId } = await pairInChannel();
    const aSock = await ready(alice.token, channelId);
    const bSock = await ready(bob.token, channelId);

    const silent = expectNoEvent(bSock, "message:new", 800);
    const ack = await send(aSock, {
      channelId,
      body: "plus tard",
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(ack.ok).toBe(true);
    expect(ack.scheduled).toBeTruthy();
    expect(ack.message).toBeUndefined();
    await silent;
  });

  it("rejects sending to a channel the user is not in", async () => {
    const { channelId } = await pairInChannel();
    // Stranger gets their own channel so we have a readiness signal for them.
    const stranger = await registerUser(srv.app);
    const own = (await authed(srv.app, stranger.token).post("/channels").send({ name: "perso" })).body.channel;
    const sSock = await ready(stranger.token, own.id);
    const ack = await send(sSock, { channelId, body: "intrus" });
    expect(ack.error).toBe("not_a_member");
  });
});

describe("message edit / delete / reactions over the socket", () => {
  it("relays message:updated and message:deleted", async () => {
    const { alice, bob, channelId } = await pairInChannel();
    const aSock = await ready(alice.token, channelId);
    const bSock = await ready(bob.token, channelId);
    const root = await send(aSock, { channelId, body: "original" });
    const id = root.message.id;

    const updated = waitForEvent(bSock, "message:updated", (m) => m.id === id);
    await authed(srv.app, alice.token).patch(`/channels/messages/${id}`).send({ body: "édité" });
    expect((await updated).body).toBe("édité");

    const deleted = waitForEvent(bSock, "message:deleted", (m) => m.id === id);
    await authed(srv.app, alice.token).delete(`/channels/messages/${id}`);
    expect((await deleted).channelId).toBe(channelId);
  });

  it("relays reaction:update", async () => {
    const { alice, bob, channelId } = await pairInChannel();
    const aSock = await ready(alice.token, channelId);
    await ready(bob.token, channelId);
    const root = await send(aSock, { channelId, body: "react me" });

    const reactEvent = waitForEvent(aSock, "reaction:update", (e) => e.messageId === root.message.id);
    await authed(srv.app, bob.token).post(`/channels/messages/${root.message.id}/reactions`).send({ emoji: "🔥" });
    const evt = await reactEvent;
    expect(evt.reactions.find((r) => r.emoji === "🔥").count).toBe(1);
  });
});

describe("typing + channel:read", () => {
  it("relays typing:update to other members only", async () => {
    const { alice, bob, channelId } = await pairInChannel();
    const aSock = await ready(alice.token, channelId);
    const bSock = await ready(bob.token, channelId);

    const typing = waitForEvent(bSock, "typing:update", (e) => e.channelId === channelId);
    const selfSilent = expectNoEvent(aSock, "typing:update", 600);
    aSock.emit("typing", { channelId });
    const evt = await typing;
    expect(evt.userId).toBe(alice.user.id);
    await selfSilent; // sender does not receive its own typing
  });

  it("channel:read advances the membership lastReadAt", async () => {
    const { bob, channelId } = await pairInChannel();
    await prisma.membership.update({
      where: { userId_channelId: { userId: bob.user.id, channelId } },
      data: { lastReadAt: new Date(Date.now() - 60_000) },
    });
    const bSock = await ready(bob.token, channelId);
    bSock.emit("channel:read", { channelId });

    let advanced = false;
    for (let i = 0; i < 30 && !advanced; i++) {
      const m = await prisma.membership.findUnique({
        where: { userId_channelId: { userId: bob.user.id, channelId } },
      });
      if (Date.now() - new Date(m.lastReadAt).getTime() < 5000) advanced = true;
      else await new Promise((r) => setTimeout(r, 100));
    }
    expect(advanced).toBe(true);
  });

  it("syncs channel:read to the user's other devices (not the sender)", async () => {
    const alice = await registerUser(srv.app);
    const ch = (await authed(srv.app, alice.token).post("/channels").send({ name: "sync" })).body.channel;
    const dev1 = await ready(alice.token, ch.id);
    const dev2 = await ready(alice.token, ch.id);

    const readOnDev2 = waitForEvent(dev2, "channel:read", (e) => e.channelId === ch.id);
    const senderSilent = expectNoEvent(dev1, "channel:read", 600);
    dev1.emit("channel:read", { channelId: ch.id });
    expect((await readOnDev2).channelId).toBe(ch.id);
    await senderSilent; // the device that read does not receive its own echo
  });
});

describe("presence", () => {
  it("announces online state and transitions", async () => {
    const alice = await registerUser(srv.app);
    const bob = await registerUser(srv.app);
    const aSock = track(await connectSocket(srv.url, alice.token));

    // bob connects: alice should see presence:update online, bob gets presence:state.
    const aliceSeesBobOnline = waitForEvent(aSock, "presence:update", (e) => e.userId === bob.user.id && e.online);
    const bSock = track(newSocket(srv.url, bob.token));
    const bobState = new Promise((res) => bSock.once("presence:state", res));
    await waitConnect(bSock);
    await aliceSeesBobOnline;
    expect((await bobState).userIds).toContain(alice.user.id);

    // bob disconnects: alice should see offline.
    const aliceSeesBobOffline = waitForEvent(aSock, "presence:update", (e) => e.userId === bob.user.id && !e.online);
    bSock.disconnect();
    await aliceSeesBobOffline;
  });
});

describe("channel membership events", () => {
  it("emits channel:created to a newly added member and channel:members to the room", async () => {
    const alice = await registerUser(srv.app);
    const bob = await registerUser(srv.app);
    const ch = (await authed(srv.app, alice.token).post("/channels").send({ name: "equipe" })).body.channel;

    const aSock = await ready(alice.token, ch.id);
    const bSock = track(await connectSocket(srv.url, bob.token));

    const bobAdded = waitForEvent(bSock, "channel:created", (c) => c.id === ch.id);
    const roomNotified = waitForEvent(aSock, "channel:members", (e) => e.channelId === ch.id);
    await authed(srv.app, alice.token).post(`/channels/${ch.id}/members`).send({ userIds: [bob.user.id] });
    await bobAdded;
    expect((await roomNotified).members.map((m) => m.id)).toContain(bob.user.id);

    // removing bob emits channel:removed to him
    const bobRemoved = waitForEvent(bSock, "channel:removed", (e) => e.channelId === ch.id);
    await authed(srv.app, alice.token).delete(`/channels/${ch.id}/members/${bob.user.id}`);
    await bobRemoved;
  });
});
