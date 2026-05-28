import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createServer } from "../../src/index.js";
import { registerUser } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";
import { findEmail } from "../helpers/mail.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1e4);

describe("password reset", () => {
  it("full flow: forgot → email captured → validate token → reset → auto-login", async () => {
    const { user, input } = await registerUser(app, {
      email: `pwreset_${uniq()}@test.local`,
      password: "oldpass1",
    });

    const ask = await request(app)
      .post("/auth/forgot-password")
      .send({ emailOrUsername: user.email });
    expect(ask.status).toBe(200);
    expect(ask.body.ok).toBe(true);

    const mail = await findEmail(user.email, { subjectIncludes: "Réinitialisation" });
    expect(mail).not.toBeNull();
    // The token in the DB matches what's in the email.
    const row = await prisma.passwordReset.findFirst({
      where: { userId: user.id, usedAt: null },
      orderBy: { createdAt: "desc" },
    });
    expect(row).not.toBeNull();
    expect(mail.text).toContain(row.token);

    const check = await request(app).get(`/auth/password-reset/${row.token}`);
    expect(check.status).toBe(200);
    expect(check.body.valid).toBe(true);
    expect(check.body.expired).toBe(false);
    expect(check.body.used).toBe(false);
    expect(check.body.email).toContain("@"); // masked

    const reset = await request(app)
      .post("/auth/reset-password")
      .send({ token: row.token, password: "brandnew9" });
    expect(reset.status).toBe(200);
    expect(reset.body.token).toBeTruthy(); // auto-login JWT
    expect(reset.body.user.id).toBe(user.id);

    // The token is consumed and can't be reused.
    const reuse = await request(app)
      .post("/auth/reset-password")
      .send({ token: row.token, password: "anotherone" });
    expect(reuse.status).toBe(403);
    expect(reuse.body.error).toBe("invalid_token");

    // Old password no longer works, new one does.
    const old = await request(app)
      .post("/auth/login")
      .send({ emailOrUsername: input.email, password: "oldpass1" });
    expect(old.status).toBe(401);
    const fresh = await request(app)
      .post("/auth/login")
      .send({ emailOrUsername: input.email, password: "brandnew9" });
    expect(fresh.status).toBe(200);
  });

  it("forgot-password returns 200 even for unknown accounts (no enumeration)", async () => {
    await registerUser(app); // bootstrap admin so DB isn't empty
    const before = await prisma.passwordReset.count();
    const res = await request(app)
      .post("/auth/forgot-password")
      .send({ emailOrUsername: `ghost_${uniq()}@test.local` });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // No row created for the unknown account.
    expect(await prisma.passwordReset.count()).toBe(before);
  });

  it("validate endpoint reports expired/used correctly", async () => {
    const { user } = await registerUser(app);

    // Expired
    const t1 = "expired_" + uniq();
    await prisma.passwordReset.create({
      data: {
        userId: user.id,
        token: t1,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const r1 = await request(app).get(`/auth/password-reset/${t1}`);
    expect(r1.body).toMatchObject({ valid: false, expired: true, used: false });
    const reset = await request(app)
      .post("/auth/reset-password")
      .send({ token: t1, password: "newpass1" });
    expect(reset.status).toBe(403);
    expect(reset.body.error).toBe("expired_token");

    // Used
    const t2 = "used_" + uniq();
    await prisma.passwordReset.create({
      data: {
        userId: user.id,
        token: t2,
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: new Date(),
      },
    });
    const r2 = await request(app).get(`/auth/password-reset/${t2}`);
    expect(r2.body).toMatchObject({ valid: false, expired: false, used: true });
  });

  it("rejects unknown tokens and weak passwords", async () => {
    expect((await request(app).get("/auth/password-reset/nope")).status).toBe(404);
    const r = await request(app)
      .post("/auth/reset-password")
      .send({ token: "nope", password: "short" });
    expect(r.status).toBe(400); // zod: password too short
  });

  it("requesting a new reset invalidates any pending reset for the same user", async () => {
    const { user } = await registerUser(app, {
      email: `multi_${uniq()}@test.local`,
    });
    await request(app)
      .post("/auth/forgot-password")
      .send({ emailOrUsername: user.email });
    await request(app)
      .post("/auth/forgot-password")
      .send({ emailOrUsername: user.email });
    const rows = await prisma.passwordReset.findMany({
      where: { userId: user.id, usedAt: null },
    });
    expect(rows).toHaveLength(1);
  });
});
