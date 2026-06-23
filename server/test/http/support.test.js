import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
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
    stubFetch();

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
