import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { startTestServer, connectSocket, waitInRoom, waitForEvent } from "../helpers/server.js";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";
import { stopTyping } from "../../src/claudeHelper.ts";

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
  vi.unstubAllGlobals();
  delete process.env.CLAUDE_HELPER_URL;
  delete process.env.CLAUDE_HELPER_TOKEN;
  delete process.env.CLAUDE_CALLBACK_TOKEN;
});

function enableBridge() {
  process.env.CLAUDE_HELPER_URL = "http://helper.test:7070";
  process.env.CLAUDE_HELPER_TOKEN = "helper-secret";
  process.env.CLAUDE_CALLBACK_TOKEN = "callback-secret";
}

// Le parcours complet côté chat : un message dans la conversation de l'expert
// déclenche le POST /turn vers le helper (stubé), l'indicateur de saisie du bot
// s'affiche, puis le callback livre la réponse en temps réel + notification.
describe("pont expert Claude (socket)", () => {
  it("message:send → POST /turn + typing du bot ; callback → message:new + notification", async () => {
    enableBridge();

    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      })
    );

    const u = await registerUser(srv.app);
    const channel = (
      await authed(srv.app, u.token).post("/claude/conversation").send({})
    ).body.channel;
    const bot = await prisma.user.findUnique({ where: { username: "claude" } });

    const s = open[open.push(await connectSocket(srv.url, u.token)) - 1];
    await waitInRoom(srv.io, channel.id, s.id);

    // L'indicateur du bot part dès que le helper a répondu 202.
    const typing = waitForEvent(
      s,
      "typing:update",
      (t) => t.channelId === channel.id && t.userId === bot.id
    );
    const ackOk = await new Promise((resolve) =>
      s.emit(
        "message:send",
        { channelId: channel.id, body: "Le runner semble bloqué, tu peux regarder ?" },
        resolve
      )
    );
    expect(ackOk.ok).toBe(true);
    await typing;

    // Le helper a bien été appelé, authentifié, avec la conversation en clé.
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://helper.test:7070/turn");
    expect(calls[0].init.headers.Authorization).toBe("Bearer helper-secret");
    const payload = JSON.parse(calls[0].init.body);
    expect(payload.conversationKey).toBe(channel.id);
    expect(payload.message).toContain("runner");
    expect(payload.author.displayName).toBe(u.user.displayName);

    // La réponse revient par le callback → message temps réel + notification.
    const incoming = waitForEvent(s, "message:new", (m) => m.channelId === channel.id && m.author?.username === "claude");
    const notified = waitForEvent(s, "notification", (n) => n.channelId === channel.id);
    const cb = await request(srv.app)
      .post("/claude/callback")
      .set("Authorization", "Bearer callback-secret")
      .send({ channelId: channel.id, ok: true, reply: "**Diagnostic** : le conteneur est Up mais…" });
    expect(cb.status).toBe(200);

    const msg = await incoming;
    expect(msg.body).toContain("Diagnostic");
    expect(msg.author.displayName).toBe("Claude");
    await notified;

    stopTyping(channel.id); // hygiène : pas de timer résiduel entre tests
  });

  it("helper injoignable → message d'excuse du bot, l'envoi utilisateur reste ok", async () => {
    enableBridge();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 }))
    );

    const u = await registerUser(srv.app);
    const channel = (
      await authed(srv.app, u.token).post("/claude/conversation").send({})
    ).body.channel;
    const s = open[open.push(await connectSocket(srv.url, u.token)) - 1];
    await waitInRoom(srv.io, channel.id, s.id);

    const apology = waitForEvent(
      s,
      "message:new",
      (m) => m.channelId === channel.id && m.author?.username === "claude"
    );
    const ack = await new Promise((resolve) =>
      s.emit("message:send", { channelId: channel.id, body: "hello ?" }, resolve)
    );
    expect(ack.ok).toBe(true); // l'échec du pont ne casse jamais l'envoi

    const msg = await apology;
    expect(msg.body).toContain("injoignable");
  });

  it("un salon normal ne déclenche jamais le pont", async () => {
    enableBridge();
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchSpy);

    const u = await registerUser(srv.app);
    const salon = (
      await authed(srv.app, u.token).post("/channels").send({ name: `salon-${Date.now()}` })
    ).body.channel;
    const s = open[open.push(await connectSocket(srv.url, u.token)) - 1];
    await waitInRoom(srv.io, salon.id, s.id);

    const ack = await new Promise((resolve) =>
      s.emit("message:send", { channelId: salon.id, body: "message ordinaire" }, resolve)
    );
    expect(ack.ok).toBe(true);
    // Laisser le fire-and-forget éventuel se déclencher, puis vérifier qu'il n'a pas eu lieu.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
