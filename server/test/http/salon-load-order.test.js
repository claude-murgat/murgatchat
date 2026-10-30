// notify.ts chargé AVANT channels.ts — comme le font claudeHelper.ts et
// diskAlert.ts —, ce qui renverse l'ordre d'évaluation des deux modules, qui
// s'importent l'un l'autre : channels.ts s'évalue alors avant que BOT_USERNAME
// existe. Ses filtres ne doivent pas le lire au chargement, sans quoi le bot
// technique cesserait d'être écarté des successeurs d'un admin (ou le serveur
// planterait au démarrage sous Node, ReferenceError).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureBot } from "../../src/notify.ts";
import { createServer } from "../../src/index.ts";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

describe("ordre de chargement notify.ts → channels.ts", () => {
  it("le bot, plus ancien membre, ne reprend pas le salon du dernier admin qui part", async () => {
    await registerUser(app);
    const { token: aliceTok } = await registerUser(app);
    const { token: bobTok, user: bob } = await registerUser(app);
    const ch = (await authed(app, aliceTok).post("/channels").send({ name: "ordre", memberIds: [bob.id] }))
      .body.channel;
    const bot = await ensureBot();
    await prisma.membership.create({
      data: { userId: bot.id, channelId: ch.id, joinedAt: new Date("2025-12-01") },
    });
    await prisma.membership.update({
      where: { userId_channelId: { userId: bob.id, channelId: ch.id } },
      data: { joinedAt: new Date("2026-01-01") },
    });

    expect((await authed(app, aliceTok).post(`/channels/${ch.id}/leave`)).status).toBe(200);
    const list = (await authed(app, bobTok).get("/channels")).body.channels;
    expect(list.find((c) => c.id === ch.id).adminIds).toEqual([bob.id]);
  });
});
