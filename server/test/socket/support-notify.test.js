import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { startTestServer, connectSocket, waitInRoom, waitForEvent } from "../helpers/server.js";
import { registerUser, authed } from "../helpers/api.js";

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
