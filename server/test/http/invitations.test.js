import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createServer } from "../../src/index.js";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";
import { findInvitationEmail } from "../helpers/mail.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1e4);

describe("invitations", () => {
  it("admin invites → email is caught (with code) → registration works → token consumed", async () => {
    const admin = await registerUser(app); // bootstrap = admin
    const email = `invitee_${uniq()}@test.local`;

    const inv = await authed(app, admin.token).post("/auth/invitations").send({ email });
    expect(inv.status).toBe(200);
    expect(inv.body.token).toBeTruthy();
    expect(inv.body.link).toContain(inv.body.token);

    // The invitation email landed in Mailpit and contains the code.
    const mail = await findInvitationEmail(email);
    expect(mail).not.toBeNull();
    expect(mail.subject).toMatch(/[Ii]nvitation/);
    expect(mail.text).toContain(inv.body.token);

    const reg = await request(app).post("/auth/register").send({
      token: inv.body.token,
      email,
      username: `u${uniq()}`.slice(0, 30),
      displayName: "Invitee",
      password: "test1234",
    });
    expect(reg.status).toBe(200);
    expect(reg.body.user.isAdmin).toBe(false);

    const stored = await prisma.invitation.findUnique({ where: { token: inv.body.token } });
    expect(stored.acceptedAt).not.toBeNull();
  });

  it("rejects invitation creation by a non-admin (403)", async () => {
    await registerUser(app); // bootstrap admin
    const member = await registerUser(app); // invited by admin → not admin
    const res = await authed(app, member.token)
      .post("/auth/invitations")
      .send({ email: `x_${uniq()}@test.local` });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("admin_required");
  });

  it("rejects inviting an already-registered email (409)", async () => {
    const admin = await registerUser(app);
    const res = await authed(app, admin.token)
      .post("/auth/invitations")
      .send({ email: admin.user.email });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_registered");
  });

  it("lists invitations (admin) and validates a token publicly", async () => {
    const admin = await registerUser(app);
    const email = `pending_${uniq()}@test.local`;
    const inv = await authed(app, admin.token).post("/auth/invitations").send({ email });

    const list = await authed(app, admin.token).get("/auth/invitations");
    expect(list.status).toBe(200);
    expect(list.body.invitations.some((i) => i.email === email && i.pending)).toBe(true);

    const check = await request(app).get(`/auth/invitations/${inv.body.token}`);
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ email, valid: true, expired: false, accepted: false });

    expect((await request(app).get("/auth/invitations/deadbeef")).status).toBe(404);
  });

  it("rejects an expired invitation at registration", async () => {
    const admin = await registerUser(app);
    const email = `exp_${uniq()}@test.local`;
    const inv = await authed(app, admin.token).post("/auth/invitations").send({ email });

    await prisma.invitation.update({
      where: { token: inv.body.token },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const reg = await request(app).post("/auth/register").send({
      token: inv.body.token,
      email,
      username: `e${uniq()}`.slice(0, 30),
      displayName: "x",
      password: "test1234",
    });
    expect(reg.status).toBe(403);
    expect(reg.body.error).toBe("invitation_expired");

    const check = await request(app).get(`/auth/invitations/${inv.body.token}`);
    expect(check.body).toMatchObject({ valid: false, expired: true });
  });
});
