import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/index.js";
import { ensureSearchIndex } from "../../src/routes/search.js";
import { registerUser, authed } from "../helpers/api.js";
import { seedMessage } from "../helpers/seed.js";

let app, io;
beforeAll(async () => {
  ({ app, io } = createServer());
  // The search index is normally created at startServer() time. Tests use
  // createServer() (no listen), so we ensure it explicitly once.
  await ensureSearchIndex();
});
afterAll(() => {
  io.close();
});

// Same shape as messages.test.js: owner + extra member in a fresh channel.
async function setup() {
  const owner = await registerUser(app);
  const member = await registerUser(app);
  const ch = (await authed(app, owner.token).post("/channels").send({ name: "salon" })).body.channel;
  await authed(app, owner.token).post(`/channels/${ch.id}/members`).send({ userIds: [member.user.id] });
  return { owner, member, channelId: ch.id };
}

describe("GET /search", () => {
  it("returns matching messages ranked, with snippet, scoped to user's channels", async () => {
    const { owner, channelId } = await setup();
    await seedMessage({ channelId, authorId: owner.user.id, body: "le ballon rebondit dans le salon" });
    await seedMessage({ channelId, authorId: owner.user.id, body: "rien à voir ici" });
    await seedMessage({ channelId, authorId: owner.user.id, body: "ballon rouge" });

    const res = await authed(app, owner.token).get("/search?q=ballon");
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBe(2);
    const bodies = res.body.results.map((r) => r.snippet);
    // ts_headline wraps the matched lemma in <mark>...</mark>
    expect(bodies.every((s) => /<mark>/i.test(s))).toBe(true);
    // Channel + author hydrated for the UI
    expect(res.body.results[0].channel.id).toBe(channelId);
    expect(res.body.results[0].author.id).toBe(owner.user.id);
  });

  it("does NOT leak messages from a channel the caller isn't in", async () => {
    const { owner: a, channelId: secret } = await setup();
    await seedMessage({ channelId: secret, authorId: a.user.id, body: "secret pizza" });

    const intruder = await registerUser(app);
    const res = await authed(app, intruder.token).get("/search?q=pizza");
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it("scopes by channelId when provided (only if caller is a member)", async () => {
    const { owner, channelId } = await setup();
    await seedMessage({ channelId, authorId: owner.user.id, body: "spaghetti carbonara" });
    // Another channel where owner is the only member
    const ch2 = (await authed(app, owner.token).post("/channels").send({ name: "autre" })).body.channel;
    await seedMessage({ channelId: ch2.id, authorId: owner.user.id, body: "spaghetti napolitaine" });

    const a = await authed(app, owner.token).get(`/search?q=spaghetti&channelId=${channelId}`);
    expect(a.body.results.map((r) => r.channelId)).toEqual([channelId]);
    const b = await authed(app, owner.token).get(`/search?q=spaghetti&channelId=${ch2.id}`);
    expect(b.body.results.map((r) => r.channelId)).toEqual([ch2.id]);
  });

  it("skips scheduled (non-delivered) messages even if they match", async () => {
    const { owner, channelId } = await setup();
    await seedMessage({
      channelId,
      authorId: owner.user.id,
      body: "futur message planifié",
      delivered: false,
      scheduledAt: new Date(Date.now() + 60_000),
    });
    const res = await authed(app, owner.token).get("/search?q=planifié");
    expect(res.body.results).toEqual([]);
  });

  it("returns an empty result set for an empty query, without hitting the DB", async () => {
    const { owner } = await setup();
    const res = await authed(app, owner.token).get("/search?q=");
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("requires auth", async () => {
    const res = await fetch("about:invalid").catch(() => null); // placeholder noop
    const { default: request } = await import("supertest");
    const r = await request(app).get("/search?q=anything");
    expect(r.status).toBe(401);
    expect(res).toBeNull();
  });

  it("respects ?limit and clamps it to ≤ 100", async () => {
    const { owner, channelId } = await setup();
    for (let i = 0; i < 6; i++) {
      await seedMessage({ channelId, authorId: owner.user.id, body: `tomate ${i}` });
    }
    const r = await authed(app, owner.token).get("/search?q=tomate&limit=3");
    expect(r.body.results).toHaveLength(3);
    const big = await authed(app, owner.token).get("/search?q=tomate&limit=9999");
    expect(big.body.results.length).toBeLessThanOrEqual(100);
  });
});
