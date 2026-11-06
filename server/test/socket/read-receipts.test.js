import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  startTestServer,
  connectSocket,
  waitForEvent,
  expectNoEvent,
  waitInRoom,
} from "../helpers/server.js";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";
import { seedMessage } from "../helpers/seed.js";

// Accusés de lecture (1.6.5) : le client signale le message le plus récent qu'il
// a eu à l'écran (`channel:read` + `messageId`). `seenAt` (accusés) et
// `lastReadAt` (non-lus, reprise de lecture) avancent jusqu'à lui, jamais en
// arrière, et les membres du salon — eux seuls — l'apprennent en direct
// (`channel:seen`). `channel:read` sans message (« Marquer comme lu », client
// antérieur) lit tout, sans accusé de lecture.

let srv;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});

const open = [];
const track = (s) => {
  open.push(s);
  return s;
};
afterEach(() => {
  for (const s of open) s.disconnect();
  open.length = 0;
});

async function ready(token, channelId) {
  const s = track(await connectSocket(srv.url, token));
  await waitInRoom(srv.io, channelId, s.id);
  return s;
}

// Alice et Bob membres depuis une heure ; trois messages d'Alice (m0 < m1 < m2)
// postés depuis, que Bob n'a pas encore lus.
async function setup() {
  const alice = await registerUser(srv.app);
  const bob = await registerUser(srv.app);
  const ch = (await authed(srv.app, alice.token).post("/channels").send({ name: "vu" })).body.channel;
  await authed(srv.app, alice.token).post(`/channels/${ch.id}/members`).send({ userIds: [bob.user.id] });
  const t0 = Date.now() - 60 * 60_000;
  await prisma.membership.updateMany({
    where: { channelId: ch.id },
    data: { joinedAt: new Date(t0), lastReadAt: new Date(t0) },
  });
  const msgs = [];
  for (let i = 0; i < 3; i++) {
    msgs.push(
      await seedMessage({
        channelId: ch.id,
        authorId: alice.user.id,
        body: `m${i}`,
        createdAt: new Date(t0 + (i + 1) * 60_000),
      })
    );
  }
  return { alice, bob, channelId: ch.id, msgs };
}

const membership = (userId, channelId) =>
  prisma.membership.findUnique({ where: { userId_channelId: { userId, channelId } } });

const channelFor = async (token, channelId) =>
  (await authed(srv.app, token).get("/channels")).body.channels.find((c) => c.id === channelId);

describe("channel:read avec le message affiché", () => {
  it("avance seenAt et lastReadAt jusqu'à lui et l'annonce aux membres", async () => {
    const { alice, bob, channelId, msgs } = await setup();
    const aliceSock = await ready(alice.token, channelId);
    const bobSock = await ready(bob.token, channelId);

    const seen = waitForEvent(aliceSock, "channel:seen", (e) => e.userId === bob.user.id);
    bobSock.emit("channel:read", { channelId, messageId: msgs[1].id });
    const ev = await seen;
    expect(ev.channelId).toBe(channelId);
    expect(new Date(ev.seenAt).getTime()).toBe(msgs[1].createdAt.getTime());
    expect(new Date(ev.joinedAt).getTime()).toBeLessThan(msgs[0].createdAt.getTime());

    const m = await membership(bob.user.id, channelId);
    expect(m.seenAt.getTime()).toBe(msgs[1].createdAt.getTime());
    expect(m.lastReadAt.getTime()).toBe(msgs[1].createdAt.getTime());
  });

  it("ne recule jamais : remonter sur un message plus ancien ne change rien", async () => {
    const { alice, bob, channelId, msgs } = await setup();
    const aliceSock = await ready(alice.token, channelId);
    const bobSock = await ready(bob.token, channelId);
    const seen = waitForEvent(aliceSock, "channel:seen");
    bobSock.emit("channel:read", { channelId, messageId: msgs[2].id });
    await seen;

    const silent = expectNoEvent(aliceSock, "channel:seen");
    bobSock.emit("channel:read", { channelId, messageId: msgs[0].id });
    await silent;
    const m = await membership(bob.user.id, channelId);
    expect(m.seenAt.getTime()).toBe(msgs[2].createdAt.getTime());
    expect(m.lastReadAt.getTime()).toBe(msgs[2].createdAt.getTime());
  });

  it("ignore un message d'un autre salon, et un salon dont on n'est pas membre", async () => {
    const { alice, bob, channelId } = await setup();
    const other = (await authed(srv.app, alice.token).post("/channels").send({ name: "autre" })).body
      .channel;
    const foreign = await seedMessage({ channelId: other.id, authorId: alice.user.id, body: "x" });
    const aliceSock = await ready(alice.token, other.id);
    const bobSock = track(await connectSocket(srv.url, bob.token));
    await waitInRoom(srv.io, channelId, bobSock.id);

    const silent = expectNoEvent(aliceSock, "channel:seen");
    // Le message d'« autre » présenté comme vu dans le salon de Bob…
    bobSock.emit("channel:read", { channelId, messageId: foreign.id });
    // … puis dans « autre », dont Bob n'est pas membre.
    bobSock.emit("channel:read", { channelId: other.id, messageId: foreign.id });
    await silent;
    expect((await membership(bob.user.id, channelId)).seenAt).toBeNull();
    expect(await membership(bob.user.id, other.id)).toBeNull();
  });

  it("lecture partielle : le salon reste non lu, la reprise se fait au premier message non affiché", async () => {
    const { bob, channelId, msgs } = await setup();
    const bobSock = await ready(bob.token, channelId);
    // Un second appareil de Bob : il ne doit pas effacer son badge pour autant.
    const bobPhone = await ready(bob.token, channelId);

    const silent = expectNoEvent(bobPhone, "channel:read");
    bobSock.emit("channel:read", { channelId, messageId: msgs[0].id });
    await silent;
    expect((await channelFor(bob.token, channelId)).unread).toBe(true);
    const page = (await authed(srv.app, bob.token).get(`/channels/${channelId}/messages`)).body;
    expect(page.firstUnreadId).toBe(msgs[1].id);

    // Arrivé en bas : tout est lu, et l'autre appareil efface son badge.
    const cleared = waitForEvent(bobPhone, "channel:read", (e) => e.channelId === channelId);
    bobSock.emit("channel:read", { channelId, messageId: msgs[2].id });
    await cleared;
    expect((await channelFor(bob.token, channelId)).unread).toBe(false);
  });

  it("sans message (« Marquer comme lu ») : tout est lu, sans accusé de lecture", async () => {
    const { alice, bob, channelId } = await setup();
    const aliceSock = await ready(alice.token, channelId);
    const bobSock = await ready(bob.token, channelId);
    const bobPhone = await ready(bob.token, channelId);

    const silent = expectNoEvent(aliceSock, "channel:seen");
    const cleared = waitForEvent(bobPhone, "channel:read", (e) => e.channelId === channelId);
    bobSock.emit("channel:read", { channelId });
    await Promise.all([silent, cleared]);
    expect((await channelFor(bob.token, channelId)).unread).toBe(false);
    expect((await membership(bob.user.id, channelId)).seenAt).toBeNull();
  });
});

describe("GET /channels/:id/messages : positions vues", () => {
  it("renvoie celles des membres au chargement initial, rien en pagination", async () => {
    const { alice, bob, channelId, msgs } = await setup();
    const aliceSock = await ready(alice.token, channelId);
    const bobSock = await ready(bob.token, channelId);
    const seen = waitForEvent(aliceSock, "channel:seen");
    bobSock.emit("channel:read", { channelId, messageId: msgs[1].id });
    await seen;

    const page = (await authed(srv.app, alice.token).get(`/channels/${channelId}/messages`)).body;
    expect(page.reads).toHaveLength(1);
    expect(page.reads[0].userId).toBe(bob.user.id);
    expect(new Date(page.reads[0].seenAt).getTime()).toBe(msgs[1].createdAt.getTime());
    expect(page.reads[0].joinedAt).toBeTruthy();

    const older = (
      await authed(srv.app, alice.token).get(`/channels/${channelId}/messages?before=${msgs[2].id}`)
    ).body;
    expect(older.reads).toEqual([]);
  });
});
