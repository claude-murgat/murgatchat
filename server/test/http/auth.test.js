import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createServer } from "../../src/index.js";
import { ensureDefaultChannel } from "../../src/routes/channels.js";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

describe("POST /auth/register (invitation-based)", () => {
  it("bootstraps the first user as admin without an invitation", async () => {
    const res = await request(app).post("/auth/register").send({
      email: "first@test.local",
      username: "firstadmin",
      displayName: "First",
      password: "test1234",
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.user.isAdmin).toBe(true);
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.user.avatarColor).toBeTruthy();
  });

  it("requires an invitation once the first user exists", async () => {
    await registerUser(app); // bootstrap admin
    const res = await request(app).post("/auth/register").send({
      email: "walkin@test.local",
      username: "walkin",
      displayName: "Walk In",
      password: "test1234",
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invitation_required");
  });

  it("registers via a valid invitation (non-admin) and consumes the token", async () => {
    const admin = await registerUser(app); // bootstrap admin
    const inv = await authed(app, admin.token)
      .post("/auth/invitations")
      .send({ email: "invited@test.local" });
    expect(inv.status).toBe(200);

    const reg = await request(app).post("/auth/register").send({
      token: inv.body.token,
      email: "invited@test.local",
      username: "invited",
      displayName: "Invited",
      password: "test1234",
    });
    expect(reg.status).toBe(200);
    expect(reg.body.user.isAdmin).toBe(false);

    // token consumed -> reuse rejected
    const reuse = await request(app).post("/auth/register").send({
      token: inv.body.token,
      email: "invited@test.local",
      username: "invited2",
      displayName: "x",
      password: "test1234",
    });
    expect(reuse.status).toBe(403);
    expect(reuse.body.error).toBe("invalid_invitation");
  });

  it("rejects an email mismatch and an unknown token", async () => {
    const admin = await registerUser(app);
    const inv = await authed(app, admin.token)
      .post("/auth/invitations")
      .send({ email: "match@test.local" });
    const mismatch = await request(app).post("/auth/register").send({
      token: inv.body.token,
      email: "nomatch@test.local",
      username: "nm",
      displayName: "x",
      password: "test1234",
    });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error).toBe("invitation_email_mismatch");

    const unknown = await request(app).post("/auth/register").send({
      token: "deadbeef",
      email: "x@test.local",
      username: "xx",
      displayName: "x",
      password: "test1234",
    });
    expect(unknown.status).toBe(403);
  });

  it("validates the payload (400)", async () => {
    for (const bad of [
      { email: "nope", username: "ok", displayName: "X", password: "test1234" },
      { email: "a@b.co", username: "ok", displayName: "X", password: "123" },
      { email: "a@b.co", username: "a", displayName: "X", password: "test1234" },
      { email: "a@b.co", username: "bad name!", displayName: "X", password: "test1234" },
    ]) {
      const res = await request(app).post("/auth/register").send(bad);
      expect(res.status).toBe(400);
    }
  });

  it("rejects a duplicate username via an invitation (409)", async () => {
    const admin = await registerUser(app, { username: "taken" });
    const inv = await authed(app, admin.token)
      .post("/auth/invitations")
      .send({ email: "dupe@test.local" });
    const res = await request(app).post("/auth/register").send({
      token: inv.body.token,
      email: "dupe@test.local",
      username: "taken",
      displayName: "x",
      password: "test1234",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("email_or_username_taken");
  });

  it("auto-joins the default channel 'Général'", async () => {
    const def = await ensureDefaultChannel();
    const { token, user } = await registerUser(app);

    const membership = await prisma.membership.findUnique({
      where: { userId_channelId: { userId: user.id, channelId: def.id } },
    });
    expect(membership).not.toBeNull();

    const list = await authed(app, token).get("/channels");
    expect(list.body.channels.some((c) => c.isDefault && c.name === "Général")).toBe(true);
  });
});

describe("POST /auth/login", () => {
  it("logs in by email and by username", async () => {
    const { input } = await registerUser(app, {
      email: "log@test.local",
      username: "loguser",
      password: "secret123",
    });

    const byEmail = await request(app)
      .post("/auth/login")
      .send({ emailOrUsername: input.email, password: "secret123" });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.token).toBeTruthy();

    const byUsername = await request(app)
      .post("/auth/login")
      .send({ emailOrUsername: input.username, password: "secret123" });
    expect(byUsername.status).toBe(200);
  });

  it("rejects wrong password and unknown user with 401", async () => {
    const { input } = await registerUser(app);
    const wrong = await request(app)
      .post("/auth/login")
      .send({ emailOrUsername: input.email, password: "wrongpass" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("invalid_credentials");

    const unknown = await request(app)
      .post("/auth/login")
      .send({ emailOrUsername: "ghost@test.local", password: "whatever" });
    expect(unknown.status).toBe(401);
  });
});

describe("GET /auth/me", () => {
  it("returns the current user with a valid token", async () => {
    const { token, user } = await registerUser(app);
    const res = await authed(app, token).get("/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });

  it("rejects missing or invalid tokens with 401", async () => {
    expect((await request(app).get("/auth/me")).status).toBe(401);
    expect(
      (await request(app).get("/auth/me").set("Authorization", "Bearer garbage")).status
    ).toBe(401);
  });
});

describe("POST /auth/dnd", () => {
  it("sets and clears the punctual DnD window", async () => {
    const { token } = await registerUser(app);

    const on = await authed(app, token).post("/auth/dnd").send({ minutes: 30 });
    expect(on.status).toBe(200);
    expect(on.body.user.dndUntil).toBeTruthy();
    expect(new Date(on.body.user.dndUntil).getTime()).toBeGreaterThan(Date.now());

    const off = await authed(app, token).post("/auth/dnd").send({ minutes: 0 });
    expect(off.body.user.dndUntil).toBeNull();
  });
});

describe("POST /auth/dnd-schedule", () => {
  it("saves a valid HH:MM range", async () => {
    const { token } = await registerUser(app);
    const res = await authed(app, token)
      .post("/auth/dnd-schedule")
      .send({ enabled: true, start: "22:00", end: "07:00" });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      dndScheduleEnabled: true,
      dndStart: "22:00",
      dndEnd: "07:00",
    });
  });

  it("rejects malformed times with 400", async () => {
    const { token } = await registerUser(app);
    const res = await authed(app, token)
      .post("/auth/dnd-schedule")
      .send({ enabled: true, start: "9:99", end: "25:00" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_time");
  });

  it("clears the range when disabled", async () => {
    const { token } = await registerUser(app);
    await authed(app, token)
      .post("/auth/dnd-schedule")
      .send({ enabled: true, start: "08:00", end: "18:00" });
    const res = await authed(app, token).post("/auth/dnd-schedule").send({ enabled: false });
    expect(res.body.user.dndScheduleEnabled).toBe(false);
    expect(res.body.user.dndStart).toBeNull();
    expect(res.body.user.dndEnd).toBeNull();
  });
});

describe("push-token endpoints", () => {
  it("upserts a token (one row, latest owner) and rejects empty", async () => {
    const { token: tA, user: a } = await registerUser(app);
    const { token: tB, user: b } = await registerUser(app);
    const expoToken = "ExponentPushToken[upsert-test]";

    const ok = await authed(app, tA).post("/auth/push-token").send({ token: expoToken });
    expect(ok.status).toBe(200);

    const bad = await authed(app, tA).post("/auth/push-token").send({});
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_token");

    // Same token re-registered by another user => still a single row, reassigned.
    await authed(app, tB).post("/auth/push-token").send({ token: expoToken });
    const rows = await prisma.pushToken.findMany({ where: { token: expoToken } });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(b.id);
    expect(rows[0].platform).toBe("android");
    expect(a.id).not.toBe(b.id);
  });

  it("deletes only the caller's token", async () => {
    const { token } = await registerUser(app);
    const t = "ExponentPushToken[delete-test]";
    await authed(app, token).post("/auth/push-token").send({ token: t });
    await authed(app, token).delete("/auth/push-token").send({ token: t });
    const rows = await prisma.pushToken.findMany({ where: { token: t } });
    expect(rows).toHaveLength(0);
  });
});
