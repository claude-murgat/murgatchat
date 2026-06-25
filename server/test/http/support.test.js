import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { createServer } from "../../src/index.js";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

// Route fetch by host: Anthropic returns a clarifying turn first, then a
// submit_ticket finalize; GitHub returns the mirrored issue.
function stubFetch() {
  let anthropicCalls = 0;
  const fetchMock = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("api.anthropic.com")) {
      anthropicCalls++;
      if (anthropicCalls === 1) {
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: "Sur quelle plateforme ?" }],
            stop_reason: "end_turn",
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          content: [
            { type: "text", text: "Merci, je transmets votre ticket." },
            {
              type: "tool_use",
              name: "submit_ticket",
              input: {
                title: "Salon bloqué au chargement",
                body: "L'app reste bloquée en ouvrant un salon sur web.",
                severity: "moyenne",
                domain: "web",
              },
            },
          ],
          stop_reason: "tool_use",
        }),
      };
    }
    if (u.includes("api.github.com")) {
      return {
        ok: true,
        json: async () => ({ number: 99, html_url: "https://github.com/x/y/issues/99" }),
      };
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("POST /support/conversations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GITHUB_BUG_TOKEN;
  });

  it("503 when the support chat is disabled (no API key)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const owner = await registerUser(app);
    const res = await authed(app, owner.token)
      .post("/support/conversations")
      .send({ message: "ça plante" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("support_chat_unavailable");
  });

  it("clarifies, then finalizes into a BugReport + GitHub issue", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.GITHUB_BUG_TOKEN = "t";
    const fetchMock = stubFetch();

    const owner = await registerUser(app);

    // First turn → open conversation with a clarifying reply.
    const start = await authed(app, owner.token)
      .post("/support/conversations")
      .send({ message: "l'app reste bloquée" });
    expect(start.status).toBe(201);
    expect(start.body.status).toBe("open");
    expect(start.body.reply).toContain("plateforme");
    expect(start.body.messages).toHaveLength(2); // user + assistant

    // Second turn → Claude finalizes; issue is mirrored synchronously.
    const finish = await authed(app, owner.token)
      .post(`/support/conversations/${start.body.id}/messages`)
      .send({ message: "sur le web" });
    expect(finish.status).toBe(200);
    expect(finish.body.status).toBe("submitted");
    expect(finish.body.githubIssueNumber).toBe(99);
    expect(finish.body.githubIssueUrl).toBe("https://github.com/x/y/issues/99");

    // The finalized ticket is a real BugReport carrying the refined body.
    const conv = await prisma.supportConversation.findUnique({
      where: { id: start.body.id },
    });
    expect(conv.bugReportId).toBeTruthy();
    const report = await prisma.bugReport.findUnique({ where: { id: conv.bugReportId } });
    expect(report.githubIssueNumber).toBe(99);
    expect(report.message).toContain("bloquée");
    expect(report.message).toContain("moyenne"); // severity prefixed

    // The issue is created already triaged: only the gate label, with domain +
    // severity surfaced in the body (kept off labels so issue creation fires a
    // single labeled event → a single claude-fix run).
    const ghCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("api.github.com")
    );
    const payload = JSON.parse(ghCall[1].body);
    expect(payload.labels).toEqual(["à-valider"]);
    expect(payload.body).toContain("Domaine : Web");
    expect(payload.body).toContain("Sévérité : Moyenne");
  });

  it("carries attachments from the conversation to the finalized report (issue #96)", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.GITHUB_BUG_TOKEN = "t";
    const fetchMock = stubFetch();
    const owner = await registerUser(app);

    const up = await request(app)
      .post("/uploads")
      .set("Authorization", `Bearer ${owner.token}`)
      .attach("file", Buffer.from("fake-png"), "capture.png");
    const attId = up.body.attachment.id;

    const start = await authed(app, owner.token)
      .post("/support/conversations")
      .send({ message: "l'app plante", attachmentIds: [attId] });
    expect(start.status).toBe(201);

    // While the ticket is being composed the file hangs off the conversation.
    let att = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(att.supportConversationId).toBe(start.body.id);
    expect(att.bugReportId).toBeNull();

    const finish = await authed(app, owner.token)
      .post(`/support/conversations/${start.body.id}/messages`)
      .send({ message: "sur le web" });
    expect(finish.status).toBe(200);
    expect(finish.body.status).toBe("submitted");

    // On finalization it is re-pointed to the created BugReport.
    const conv = await prisma.supportConversation.findUnique({
      where: { id: start.body.id },
    });
    att = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(att.bugReportId).toBe(conv.bugReportId);

    // …and is inventoried in the mirrored GitHub issue.
    const ghCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("api.github.com")
    );
    const payload = JSON.parse(ghCall[1].body);
    expect(payload.body).toContain("Pièces jointes");
    expect(payload.body).toContain("capture.png");
  });

  it("rejects a turn on someone else's conversation (404)", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    stubFetch();
    const owner = await registerUser(app);
    const start = await authed(app, owner.token)
      .post("/support/conversations")
      .send({ message: "bug" });
    expect(start.status).toBe(201);

    const other = await registerUser(app);
    const res = await authed(app, other.token)
      .post(`/support/conversations/${start.body.id}/messages`)
      .send({ message: "coucou" });
    expect(res.status).toBe(404);
  });

  it("rejects further turns once the conversation is submitted (409)", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.GITHUB_BUG_TOKEN = "t";
    stubFetch();
    const owner = await registerUser(app);
    const start = await authed(app, owner.token)
      .post("/support/conversations")
      .send({ message: "bug" });
    const finish = await authed(app, owner.token)
      .post(`/support/conversations/${start.body.id}/messages`)
      .send({ message: "web" });
    expect(finish.body.status).toBe("submitted");

    const again = await authed(app, owner.token)
      .post(`/support/conversations/${start.body.id}/messages`)
      .send({ message: "encore" });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("conversation_closed");
  });
});

describe("POST /support/notify", () => {
  const PR = "https://github.com/claude-murgat/murgatchat/pull/42";

  afterEach(() => {
    delete process.env.SUPPORT_NOTIFY_TOKEN;
    delete process.env.SUPPORT_NOTIFY_CHANNEL;
  });

  it("503 when the notifier is disabled (no token)", async () => {
    delete process.env.SUPPORT_NOTIFY_TOKEN;
    const res = await request(app).post("/support/notify").send({ prUrl: PR });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("notify_disabled");
  });

  it("401 on a wrong shared secret", async () => {
    process.env.SUPPORT_NOTIFY_TOKEN = "s3cret";
    const res = await request(app)
      .post("/support/notify")
      .set("Authorization", "Bearer nope")
      .send({ prUrl: PR });
    expect(res.status).toBe(401);
  });

  it("400 on an invalid payload (missing/!url prUrl)", async () => {
    process.env.SUPPORT_NOTIFY_TOKEN = "s3cret";
    const res = await request(app)
      .post("/support/notify")
      .set("Authorization", "Bearer s3cret")
      .send({ issueNumber: 1, prUrl: "not-a-url" });
    expect(res.status).toBe(400);
  });

  it("posts a bot message into the team channel on a valid call", async () => {
    process.env.SUPPORT_NOTIFY_TOKEN = "s3cret";
    process.env.SUPPORT_NOTIFY_CHANNEL = "support-dev";
    const res = await request(app)
      .post("/support/notify")
      .set("Authorization", "Bearer s3cret")
      .send({ issueNumber: 42, prUrl: PR, title: "Salon bloqué" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const bot = await prisma.user.findUnique({ where: { username: "claude" } });
    expect(bot).not.toBeNull();
    const channel = await prisma.channel.findFirst({ where: { name: "support-dev" } });
    expect(channel).not.toBeNull();
    const msg = await prisma.message.findFirst({
      where: { channelId: channel.id, authorId: bot.id },
    });
    expect(msg).not.toBeNull();
    // searchableBody is the plaintext mirror — assert the PR link + issue made it in.
    expect(msg.searchableBody).toContain(PR);
    expect(msg.searchableBody).toContain("#42");
  });

  it("réserve le salon aux admins : le rend privé et purge les non-admins", async () => {
    process.env.SUPPORT_NOTIFY_TOKEN = "s3cret";
    process.env.SUPPORT_NOTIFY_CHANNEL = "support-dev";

    const admin = await registerUser(app); // bootstrap = admin
    const member = await registerUser(app); // invité = non-admin

    // État hérité : un salon support-dev public où un non-admin est déjà membre.
    const created = (
      await authed(app, admin.token)
        .post("/channels")
        .send({ name: "support-dev", memberIds: [member.user.id] })
    ).body.channel;
    expect(created.isPrivate).toBe(false);

    const res = await request(app)
      .post("/support/notify")
      .set("Authorization", "Bearer s3cret")
      .send({ issueNumber: 7, prUrl: PR });
    expect(res.status).toBe(200);

    const channel = await prisma.channel.findFirst({ where: { name: "support-dev" } });
    expect(channel.isPrivate).toBe(true); // verrouillé pour les non-admins

    const memberIds = (
      await prisma.membership.findMany({
        where: { channelId: channel.id },
        select: { userId: true },
      })
    ).map((m) => m.userId);
    expect(memberIds).toContain(admin.user.id); // l'admin reste membre
    expect(memberIds).not.toContain(member.user.id); // le non-admin est purgé
  });
});
