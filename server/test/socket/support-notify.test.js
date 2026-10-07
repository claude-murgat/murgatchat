import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import {
  startTestServer,
  connectSocket,
  waitInRoom,
  waitForEvent,
  expectNoEvent,
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

const open = [];
afterEach(() => {
  for (const s of open) s.disconnect();
  open.length = 0;
  delete process.env.SUPPORT_NOTIFY_TOKEN;
});

const PR = "https://github.com/claude-murgat/murgatchat/pull/42";

// Integration coverage for the part the HTTP test can't see: that POST
// /support/notify actually broadcasts the bot message over Socket.IO in real
// time to a client subscribed to the team channel.
describe("POST /support/notify → diffusion temps réel", () => {
  it("pousse message:new au membre connecté du salon quand une PR est ouverte", async () => {
    process.env.SUPPORT_NOTIFY_TOKEN = "test-secret";

    // Pre-create the "support-dev" channel so we know its id and can subscribe
    // before the notify fires. notify's ensureChannel reuses it by name.
    const alice = await registerUser(srv.app); // owner
    const ch = (
      await authed(srv.app, alice.token).post("/channels").send({ name: "support-dev" })
    ).body.channel;

    // On connect the server auto-joins the socket to its channel rooms; wait
    // until that's done so the notify can't race ahead of the subscription.
    const s = open[open.push(await connectSocket(srv.url, alice.token)) - 1];
    await waitInRoom(srv.io, ch.id, s.id);

    const incoming = waitForEvent(
      s,
      "message:new",
      (m) => m.channelId === ch.id && m.body.includes(PR)
    );

    const res = await request(srv.app)
      .post("/support/notify")
      .set("Authorization", "Bearer test-secret")
      .send({ issueNumber: 42, prUrl: PR, title: "Salon bloqué" });
    expect(res.status).toBe(200);

    const evt = await incoming;
    expect(evt.body).toContain(PR);
    expect(evt.body).toContain("#42");
    expect(evt.author.displayName).toBe("Claude"); // posted as the bot
  });

  it("notifie aussi via l'événement 'notification' (badge non-lu)", async () => {
    process.env.SUPPORT_NOTIFY_TOKEN = "test-secret";
    const alice = await registerUser(srv.app);
    // alice est ajoutée comme membre par ensureChannel ; son socket est dans la
    // room user:<id> dès la connexion → reçoit l'événement 'notification'.
    const s = open[open.push(await connectSocket(srv.url, alice.token)) - 1];

    const notif = waitForEvent(s, "notification", (p) => p.message?.body?.includes(PR));
    const res = await request(srv.app)
      .post("/support/notify")
      .set("Authorization", "Bearer test-secret")
      .send({ issueNumber: 42, prUrl: PR });
    expect(res.status).toBe(200);

    const evt = await notif;
    expect(evt.message.body).toContain(PR);
  });
});

describe("salon du pipeline : réservé aux admins, temps réel compris", () => {
  const inRoom = (socket, channelId) =>
    !!srv.io.sockets.adapter.rooms.get(`channel:${channelId}`)?.has(socket.id);

  it("un admin rétrogradé perd le salon sur-le-champ (membership et room)", async () => {
    const owner = await registerUser(srv.app);
    const admin = await registerUser(srv.app);
    await authed(srv.app, owner.token).patch(`/auth/users/${admin.user.id}`).send({ isAdmin: true });
    const ch = (
      await authed(srv.app, owner.token)
        .post("/channels")
        .send({ name: "support-dev", isPrivate: true, memberIds: [admin.user.id] })
    ).body.channel;
    const s = open[open.push(await connectSocket(srv.url, admin.token)) - 1];
    await waitInRoom(srv.io, ch.id, s.id);
    const removed = waitForEvent(s, "channel:removed", (e) => e.channelId === ch.id);

    await authed(srv.app, owner.token).patch(`/auth/users/${admin.user.id}`).send({ isAdmin: false });

    await removed;
    expect(inRoom(s, ch.id)).toBe(false);
    const left = await prisma.membership.count({ where: { channelId: ch.id, userId: admin.user.id } });
    expect(left).toBe(0);
  });

  it("la réconciliation d'une notification coupe aussi la socket d'un non-admin", async () => {
    process.env.SUPPORT_NOTIFY_TOKEN = "test-secret";
    const owner = await registerUser(srv.app);
    const member = await registerUser(srv.app);
    // État hérité : un non-admin membre du salon, connecté.
    const ch = (
      await authed(srv.app, owner.token)
        .post("/channels")
        .send({ name: "support-dev", memberIds: [member.user.id] })
    ).body.channel;
    const s = open[open.push(await connectSocket(srv.url, member.token)) - 1];
    await waitInRoom(srv.io, ch.id, s.id);
    const removed = waitForEvent(s, "channel:removed", (e) => e.channelId === ch.id);
    const leak = expectNoEvent(s, "message:new", 1000);

    const res = await request(srv.app)
      .post("/support/notify")
      .set("Authorization", "Bearer test-secret")
      .send({ issueNumber: 9, prUrl: PR });
    expect(res.status).toBe(200);

    await removed;
    await leak;
    expect(inRoom(s, ch.id)).toBe(false);
  });
});
