import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { startTestServer } from "../helpers/server.js";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";

let srv;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});

function enableBridge() {
  process.env.CLAUDE_HELPER_URL = "http://helper.test:7070";
  process.env.CLAUDE_HELPER_TOKEN = "helper-secret";
  process.env.CLAUDE_CALLBACK_TOKEN = "callback-secret";
}
afterEach(() => {
  delete process.env.CLAUDE_HELPER_URL;
  delete process.env.CLAUDE_HELPER_TOKEN;
  delete process.env.CLAUDE_CALLBACK_TOKEN;
});

describe("POST /claude/conversation", () => {
  it("503 quand le pont n'est pas configuré", async () => {
    const u = await registerUser(srv.app);
    const res = await authed(srv.app, u.token).post("/claude/conversation").send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("claude_expert_unavailable");
  });

  it("crée un canal kind=claude privé {utilisateur, bot}, idempotent", async () => {
    enableBridge();
    const u = await registerUser(srv.app);

    const res = await authed(srv.app, u.token).post("/claude/conversation").send({});
    expect(res.status).toBe(200);
    const ch = res.body.channel;
    expect(ch.kind).toBe("claude");
    expect(ch.isPrivate).toBe(true);
    expect(ch.isDirect).toBe(false);
    expect(ch.name).toBe("Expert supervision");
    const usernames = ch.members.map((m) => m.username).sort();
    expect(usernames).toContain("claude");
    expect(usernames).toContain(u.user.username);
    expect(ch.members.length).toBe(2);

    // Deuxième appel (double-clic, autre appareil) : même canal, pas un doublon.
    const again = await authed(srv.app, u.token).post("/claude/conversation").send({});
    expect(again.status).toBe(200);
    expect(again.body.channel.id).toBe(ch.id);

    // Chaque utilisateur a SA conversation.
    const v = await registerUser(srv.app);
    const other = await authed(srv.app, v.token).post("/claude/conversation").send({});
    expect(other.body.channel.id).not.toBe(ch.id);
  });
});

describe("POST /claude/callback", () => {
  async function openConversation() {
    const u = await registerUser(srv.app);
    const res = await authed(srv.app, u.token).post("/claude/conversation").send({});
    return { user: u, channel: res.body.channel };
  }

  it("401 sans le bon secret, 400 sur payload invalide", async () => {
    enableBridge();
    const { channel } = await openConversation();

    const bad = await request(srv.app)
      .post("/claude/callback")
      .set("Authorization", "Bearer mauvais-secret")
      .send({ channelId: channel.id, ok: true, reply: "coucou" });
    expect(bad.status).toBe(401);

    const invalid = await request(srv.app)
      .post("/claude/callback")
      .set("Authorization", "Bearer callback-secret")
      .send({ channelId: channel.id }); // ok manquant
    expect(invalid.status).toBe(400);
  });

  it("404 sur un canal inconnu ou un salon normal (le bot ne parle pas ailleurs)", async () => {
    enableBridge();
    const u = await registerUser(srv.app);
    const salon = (
      await authed(srv.app, u.token).post("/channels").send({ name: `salon-${Date.now()}` })
    ).body.channel;

    for (const channelId of ["cid_inexistant", salon.id]) {
      const res = await request(srv.app)
        .post("/claude/callback")
        .set("Authorization", "Bearer callback-secret")
        .send({ channelId, ok: true, reply: "détourné" });
      expect(res.status).toBe(404);
    }
  });

  it("livre la réponse comme message du bot ; ok:false poste une excuse", async () => {
    enableBridge();
    const { channel } = await openConversation();

    const ok = await request(srv.app)
      .post("/claude/callback")
      .set("Authorization", "Bearer callback-secret")
      .send({ channelId: channel.id, ok: true, reply: "Le runner est arrêté depuis 3 h." });
    expect(ok.status).toBe(200);

    const ko = await request(srv.app)
      .post("/claude/callback")
      .set("Authorization", "Bearer callback-secret")
      .send({ channelId: channel.id, ok: false, error: "timeout_15min" });
    expect(ko.status).toBe(200);

    const msgs = await prisma.message.findMany({
      where: { channelId: channel.id },
      orderBy: { createdAt: "asc" },
      include: { author: true },
    });
    expect(msgs.length).toBe(2);
    expect(msgs.every((m) => m.author.username === "claude")).toBe(true);
    expect(msgs[0].searchableBody).toContain("runner");
    expect(msgs[1].searchableBody).toContain("timeout_15min");
  });
});

describe("canaux claude figés", () => {
  it("refuse ajout / départ / retrait de membres (404, comme un canal invisible)", async () => {
    enableBridge();
    const u = await registerUser(srv.app);
    const intrus = await registerUser(srv.app);
    const channel = (
      await authed(srv.app, u.token).post("/claude/conversation").send({})
    ).body.channel;

    const add = await authed(srv.app, u.token)
      .post(`/channels/${channel.id}/members`)
      .send({ userIds: [intrus.user.id] });
    expect(add.status).toBe(404);

    const leave = await authed(srv.app, u.token).post(`/channels/${channel.id}/leave`).send({});
    expect(leave.status).toBe(404);

    const bot = await prisma.user.findUnique({ where: { username: "claude" } });
    const kick = await authed(srv.app, u.token).delete(
      `/channels/${channel.id}/members/${bot.id}`
    );
    expect(kick.status).toBe(404);
  });
});
