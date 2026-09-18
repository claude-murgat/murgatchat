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
  delete process.env.CLAUDE_EXPERTS;
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
    expect(ch.expert).toBe("supervision"); // sans `expert` dans le corps : l'historique
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

describe("experts multiples (GET /claude/experts, expert dans le corps)", () => {
  it("liste vide sans pont ; supervision seul par défaut ; CLAUDE_EXPERTS ouvre les autres", async () => {
    const u = await registerUser(srv.app);
    const off = await authed(srv.app, u.token).get("/claude/experts");
    expect(off.status).toBe(200);
    expect(off.body.experts).toEqual([]);

    enableBridge();
    const one = await authed(srv.app, u.token).get("/claude/experts");
    expect(one.body.experts.map((e) => e.key)).toEqual(["supervision"]);

    process.env.CLAUDE_EXPERTS = "supervision, management, inconnu";
    const both = await authed(srv.app, u.token).get("/claude/experts");
    expect(both.body.experts.map((e) => e.key)).toEqual(["supervision", "management"]);
    expect(both.body.experts[1].name).toBe("Expert MM");
    expect(both.body.experts[1].button).toContain("MM");
  });

  it("un canal par expert et par utilisateur, nommé d'après l'expert", async () => {
    enableBridge();
    process.env.CLAUDE_EXPERTS = "supervision,management";
    const u = await registerUser(srv.app);

    const sup = (await authed(srv.app, u.token).post("/claude/conversation").send({})).body.channel;
    const mm = (
      await authed(srv.app, u.token).post("/claude/conversation").send({ expert: "management" })
    ).body.channel;
    expect(mm.id).not.toBe(sup.id);
    expect(mm.kind).toBe("claude");
    expect(mm.expert).toBe("management");
    expect(mm.name).toBe("Expert MM");
    expect(mm.description).toContain("Murgat Management");
    expect(mm.members.map((m) => m.username)).toContain("claude");

    // Idempotent par expert : on retrouve le même canal, pas un doublon.
    const again = (
      await authed(srv.app, u.token).post("/claude/conversation").send({ expert: "management" })
    ).body.channel;
    expect(again.id).toBe(mm.id);
  });

  it("400 sur un expert inconnu ou pas ouvert sur ce serveur", async () => {
    enableBridge(); // CLAUDE_EXPERTS absent → supervision seul
    const u = await registerUser(srv.app);
    for (const expert of ["management", "nimporte"]) {
      const res = await authed(srv.app, u.token).post("/claude/conversation").send({ expert });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("unknown_expert");
    }
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
      .send({ channelId: channel.id, ok: false, error: "credit_low" });
    expect(ko.status).toBe(200);

    const msgs = await prisma.message.findMany({
      where: { channelId: channel.id },
      orderBy: { createdAt: "asc" },
      include: { author: true },
    });
    expect(msgs.length).toBe(2);
    expect(msgs.every((m) => m.author.username === "claude")).toBe(true);
    expect(msgs[0].searchableBody).toContain("runner");
    expect(msgs[1].searchableBody).toContain("crédit");
  });
});

describe("POST /claude/progress", () => {
  it("401 sans secret ; relaie sur un canal claude ; 404 ailleurs", async () => {
    enableBridge();
    const u = await registerUser(srv.app);
    const channel = (
      await authed(srv.app, u.token).post("/claude/conversation").send({})
    ).body.channel;

    const noauth = await request(srv.app)
      .post("/claude/progress")
      .send({ channelId: channel.id, text: "Lecture des logs…" });
    expect(noauth.status).toBe(401);

    const ok = await request(srv.app)
      .post("/claude/progress")
      .set("Authorization", "Bearer callback-secret")
      .send({ channelId: channel.id, text: "Lecture des logs…" });
    expect(ok.status).toBe(200);

    const salon = (
      await authed(srv.app, u.token).post("/channels").send({ name: `salon-${Date.now()}` })
    ).body.channel;
    const wrong = await request(srv.app)
      .post("/claude/progress")
      .set("Authorization", "Bearer callback-secret")
      .send({ channelId: salon.id, text: "détourné" });
    expect(wrong.status).toBe(404);
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

describe("POST /claude/conversation/:channelId/clear", () => {
  it("efface les messages et réinitialise la session", async () => {
    enableBridge();
    const u = await registerUser(srv.app);
    const channel = (
      await authed(srv.app, u.token).post("/claude/conversation").send({})
    ).body.channel;

    // Ajouter un message artificiel à la base.
    const bot = await prisma.user.findUnique({ where: { username: "claude" } });
    if (!bot) throw new Error("Bot user not found");
    await prisma.message.create({
      data: {
        channelId: channel.id,
        authorId: bot.id,
        body: "Test message",
        searchableBody: "test message",
      },
    });

    // Vérifier qu'il y a 1 message.
    let msgs = await prisma.message.count({ where: { channelId: channel.id } });
    expect(msgs).toBe(1);

    // Vider la conversation.
    const clear = await authed(srv.app, u.token).post(
      `/claude/conversation/${channel.id}/clear`
    );
    expect(clear.status).toBe(200);

    // Vérifier que les messages ont été supprimés.
    msgs = await prisma.message.count({ where: { channelId: channel.id } });
    expect(msgs).toBe(0);
  });

  it("403 si l'utilisateur n'est pas membre du canal", async () => {
    enableBridge();
    const u = await registerUser(srv.app);
    const other = await registerUser(srv.app);
    const channel = (
      await authed(srv.app, u.token).post("/claude/conversation").send({})
    ).body.channel;

    const clear = await authed(srv.app, other.token).post(
      `/claude/conversation/${channel.id}/clear`
    );
    expect(clear.status).toBe(403);
  });

  it("404 si le canal n'existe pas ou n'est pas un canal claude", async () => {
    enableBridge();
    const u = await registerUser(srv.app);
    const salon = (
      await authed(srv.app, u.token).post("/channels").send({ name: `salon-${Date.now()}` })
    ).body.channel;

    const clear = await authed(srv.app, u.token).post(
      `/claude/conversation/inexistant/clear`
    );
    expect(clear.status).toBe(404);

    const clearSalon = await authed(srv.app, u.token).post(
      `/claude/conversation/${salon.id}/clear`
    );
    expect(clearSalon.status).toBe(404);
  });
});
