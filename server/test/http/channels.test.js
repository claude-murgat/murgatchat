import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/index.js";
import { ensureDefaultChannel } from "../../src/routes/channels.js";
import { registerUser, authed } from "../helpers/api.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

const createChannel = (token, body) => authed(app, token).post("/channels").send(body);

describe("POST /channels (create) + GET /channels (list)", () => {
  it("creates a channel with the creator as member and lists it", async () => {
    const { token } = await registerUser(app);
    const res = await createChannel(token, { name: "projet-x", description: "desc" });
    expect(res.status).toBe(200);
    expect(res.body.channel).toMatchObject({ name: "projet-x", isPrivate: false, isDirect: false });
    expect(res.body.channel.members).toHaveLength(1);

    const list = await authed(app, token).get("/channels");
    expect(list.body.channels.some((c) => c.id === res.body.channel.id)).toBe(true);
  });

  it("adds initial memberIds at creation", async () => {
    const { token } = await registerUser(app);
    const { user: b } = await registerUser(app);
    const res = await createChannel(token, { name: "with-bob", memberIds: [b.id] });
    expect(res.body.channel.members.map((m) => m.id)).toContain(b.id);
  });

  it("rejects an empty name with 400", async () => {
    const { token } = await registerUser(app);
    const res = await createChannel(token, { name: "" });
    expect(res.status).toBe(400);
  });
});

describe("GET /channels/public", () => {
  it("lists joinable public channels, hides private/joined, filters by q", async () => {
    const { token: owner } = await registerUser(app);
    const pub = await createChannel(owner, { name: "annonces" });
    const priv = await createChannel(owner, { name: "secret", isPrivate: true });

    const { token: other } = await registerUser(app);
    const all = await authed(app, other).get("/channels/public");
    const ids = all.body.channels.map((c) => c.id);
    expect(ids).toContain(pub.body.channel.id); // public, not joined
    expect(ids).not.toContain(priv.body.channel.id); // private hidden
    // owner already a member of pub => not in owner's discovery list
    const ownerView = await authed(app, owner).get("/channels/public");
    expect(ownerView.body.channels.map((c) => c.id)).not.toContain(pub.body.channel.id);

    const filtered = await authed(app, other).get("/channels/public?q=ANNON");
    expect(filtered.body.channels.map((c) => c.id)).toContain(pub.body.channel.id);
    const miss = await authed(app, other).get("/channels/public?q=zzz-nope");
    expect(miss.body.channels.map((c) => c.id)).not.toContain(pub.body.channel.id);
  });
});

describe("POST /channels/:id/join", () => {
  it("joins a public channel; rejects private/direct with 404", async () => {
    const { token: owner } = await registerUser(app);
    const pub = await createChannel(owner, { name: "ouvert" });
    const priv = await createChannel(owner, { name: "ferme", isPrivate: true });

    const { token: joiner } = await registerUser(app);
    const join = await authed(app, joiner).post(`/channels/${pub.body.channel.id}/join`);
    expect(join.status).toBe(200);

    const list = await authed(app, joiner).get("/channels");
    expect(list.body.channels.some((c) => c.id === pub.body.channel.id)).toBe(true);

    const joinPriv = await authed(app, joiner).post(`/channels/${priv.body.channel.id}/join`);
    expect(joinPriv.status).toBe(404);
  });
});

describe("POST /channels/dm", () => {
  it("opens a 1:1 DM and reuses it on a second call", async () => {
    const { token: a } = await registerUser(app);
    const { user: b } = await registerUser(app);

    const first = await authed(app, a).post("/channels/dm").send({ userId: b.id });
    expect(first.status).toBe(200);
    expect(first.body.channel.isDirect).toBe(true);
    expect(first.body.channel.members).toHaveLength(2);

    const second = await authed(app, a).post("/channels/dm").send({ userId: b.id });
    expect(second.body.channel.id).toBe(first.body.channel.id);
  });

  it("opens a group DM with userIds[]", async () => {
    const { token: a } = await registerUser(app);
    const { user: b } = await registerUser(app);
    const { user: c } = await registerUser(app);
    const res = await authed(app, a).post("/channels/dm").send({ userIds: [b.id, c.id] });
    expect(res.body.channel.isDirect).toBe(true);
    expect(res.body.channel.members).toHaveLength(3);
  });

  it("rejects empty / self-only / unknown targets with 400", async () => {
    const { token: a, user: au } = await registerUser(app);
    expect((await authed(app, a).post("/channels/dm").send({})).status).toBe(400);
    expect((await authed(app, a).post("/channels/dm").send({ userId: au.id })).status).toBe(400);
    expect(
      (await authed(app, a).post("/channels/dm").send({ userId: "does-not-exist" })).status
    ).toBe(400);
  });
});

describe("members add / remove / leave", () => {
  it("adds members; rejects empty, non-member requester, and DM channels", async () => {
    const { token: owner } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app);
    const { token: cTok } = await registerUser(app);
    const ch = (await createChannel(owner, { name: "equipe" })).body.channel;

    const add = await authed(app, owner).post(`/channels/${ch.id}/members`).send({ userIds: [b.id] });
    expect(add.status).toBe(200);
    expect(add.body.channel.members.map((m) => m.id)).toContain(b.id);
    // b is now a member: can read messages
    expect((await authed(app, bTok).get(`/channels/${ch.id}/messages`)).status).toBe(200);

    expect(
      (await authed(app, owner).post(`/channels/${ch.id}/members`).send({ userIds: [] })).status
    ).toBe(400);
    // c is not a member -> 403
    expect(
      (await authed(app, cTok).post(`/channels/${ch.id}/members`).send({ userIds: [b.id] })).status
    ).toBe(403);

    const { token: x } = await registerUser(app);
    const { user: y } = await registerUser(app);
    const dm = (await authed(app, x).post("/channels/dm").send({ userId: y.id })).body.channel;
    expect(
      (await authed(app, x).post(`/channels/${dm.id}/members`).send({ userIds: [b.id] })).status
    ).toBe(404);
  });

  it("removes a member; leave works; default channel is protected", async () => {
    const def = await ensureDefaultChannel();
    const { token: owner } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app);
    const ch = (await createChannel(owner, { name: "rotation" })).body.channel;
    await authed(app, owner).post(`/channels/${ch.id}/members`).send({ userIds: [b.id] });

    const remove = await authed(app, owner).delete(`/channels/${ch.id}/members/${b.id}`);
    expect(remove.status).toBe(200);
    expect((await authed(app, bTok).get(`/channels/${ch.id}/messages`)).status).toBe(403);

    // b joins another public channel then leaves it
    const pub = (await createChannel(owner, { name: "libre" })).body.channel;
    await authed(app, bTok).post(`/channels/${pub.id}/join`);
    const leave = await authed(app, bTok).post(`/channels/${pub.id}/leave`);
    expect(leave.status).toBe(200);
    expect((await authed(app, bTok).get("/channels")).body.channels.some((c) => c.id === pub.id)).toBe(false);

    // default channel cannot be left or have members removed
    expect((await authed(app, owner).post(`/channels/${def.id}/leave`)).status).toBe(403);
    expect(
      (await authed(app, owner).delete(`/channels/${def.id}/members/${b.id}`)).status
    ).toBe(403);
  });
});
