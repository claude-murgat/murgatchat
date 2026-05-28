import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createServer } from "../../src/index.js";
import { ensureOwner } from "../../src/routes/auth.js";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

describe("roles at bootstrap + register", () => {
  it("the bootstrap account is both owner and admin", async () => {
    const { user } = await registerUser(app);
    expect(user.isAdmin).toBe(true);
    expect(user.isOwner).toBe(true);
  });

  it("an invited account is neither admin nor owner", async () => {
    await registerUser(app); // bootstrap = owner+admin
    const { user } = await registerUser(app);
    expect(user.isAdmin).toBe(false);
    expect(user.isOwner).toBe(false);
  });
});

describe("GET /auth/users", () => {
  it("rejects non-admins (403) and exposes the full list to admins", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);

    expect((await authed(app, member.token).get("/auth/users")).status).toBe(403);

    const res = await authed(app, owner.token).get("/auth/users");
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    const owned = res.body.users.find((u) => u.id === owner.user.id);
    expect(owned.isOwner).toBe(true);
    expect(owned.isAdmin).toBe(true);
  });
});

describe("PATCH /auth/users/:id (roles)", () => {
  it("only the owner can promote a member to admin", async () => {
    const owner = await registerUser(app);
    const a = await registerUser(app);
    const b = await registerUser(app);

    // Member can't promote anyone
    expect(
      (await authed(app, a.token).patch(`/auth/users/${b.user.id}`).send({ isAdmin: true })).status
    ).toBe(403);

    // Owner promotes b
    const promoted = await authed(app, owner.token)
      .patch(`/auth/users/${b.user.id}`)
      .send({ isAdmin: true });
    expect(promoted.status).toBe(200);
    expect(promoted.body.user.isAdmin).toBe(true);
    expect(promoted.body.user.isOwner).toBe(false);

    // Newly-promoted admin still cannot touch isAdmin (owner-only field)
    const c = await registerUser(app);
    expect(
      (await authed(app, b.token).patch(`/auth/users/${c.user.id}`).send({ isAdmin: true })).status
    ).toBe(403);
  });

  it("the owner cannot demote herself; cannot be edited by anyone else", async () => {
    const owner = await registerUser(app);
    const admin = await registerUser(app);
    await authed(app, owner.token)
      .patch(`/auth/users/${admin.user.id}`)
      .send({ isAdmin: true });

    const self = await authed(app, owner.token)
      .patch(`/auth/users/${owner.user.id}`)
      .send({ isAdmin: false });
    expect(self.status).toBe(403);
    expect(self.body.error).toBe("owner_protected");

    const byAdmin = await authed(app, admin.token)
      .patch(`/auth/users/${owner.user.id}`)
      .send({ status: "disabled" });
    expect(byAdmin.status).toBe(403);
  });

  it("an admin can disable a plain member but NOT another admin", async () => {
    const owner = await registerUser(app);
    const admin = await registerUser(app);
    const adminTwo = await registerUser(app);
    const member = await registerUser(app);
    await authed(app, owner.token).patch(`/auth/users/${admin.user.id}`).send({ isAdmin: true });
    await authed(app, owner.token).patch(`/auth/users/${adminTwo.user.id}`).send({ isAdmin: true });

    const onMember = await authed(app, admin.token)
      .patch(`/auth/users/${member.user.id}`)
      .send({ status: "disabled" });
    expect(onMember.status).toBe(200);
    expect(onMember.body.user.status).toBe("disabled");

    const onAdmin = await authed(app, admin.token)
      .patch(`/auth/users/${adminTwo.user.id}`)
      .send({ status: "disabled" });
    expect(onAdmin.status).toBe(403);
    expect(onAdmin.body.error).toBe("owner_required_for_admin");
  });

  it("the owner can disable an admin and re-enable them", async () => {
    const owner = await registerUser(app);
    const admin = await registerUser(app);
    await authed(app, owner.token).patch(`/auth/users/${admin.user.id}`).send({ isAdmin: true });

    const off = await authed(app, owner.token)
      .patch(`/auth/users/${admin.user.id}`)
      .send({ status: "disabled" });
    expect(off.status).toBe(200);
    expect(off.body.user.status).toBe("disabled");

    const on = await authed(app, owner.token)
      .patch(`/auth/users/${admin.user.id}`)
      .send({ status: "active" });
    expect(on.body.user.status).toBe("active");
  });

  it("a disabled user cannot log in and existing tokens are rejected by requireAuth", async () => {
    const owner = await registerUser(app);
    const victim = await registerUser(app, { password: "victim123" });

    // Token still works before disabling
    expect((await authed(app, victim.token).get("/auth/me")).status).toBe(200);

    await authed(app, owner.token)
      .patch(`/auth/users/${victim.user.id}`)
      .send({ status: "disabled" });

    // requireAuth re-checks status each request, so the old token is invalid.
    expect((await authed(app, victim.token).get("/auth/me")).status).toBe(401);

    // Login with the right password also fails (same error as wrong password — no enum).
    const login = await request(app)
      .post("/auth/login")
      .send({ emailOrUsername: victim.user.email, password: "victim123" });
    expect(login.status).toBe(401);
    expect(login.body.error).toBe("invalid_credentials");
  });
});

describe("POST /auth/transfer-ownership", () => {
  it("transfers ownership: previous owner becomes admin, new owner becomes admin too", async () => {
    const owner = await registerUser(app);
    const target = await registerUser(app);

    const res = await authed(app, owner.token)
      .post("/auth/transfer-ownership")
      .send({ targetUserId: target.user.id });
    expect(res.status).toBe(200);
    expect(res.body.newOwner.id).toBe(target.user.id);
    expect(res.body.newOwner.isOwner).toBe(true);
    expect(res.body.newOwner.isAdmin).toBe(true);

    // Old owner now has only admin rights
    const prev = await prisma.user.findUnique({ where: { id: owner.user.id } });
    expect(prev.isOwner).toBe(false);
    expect(prev.isAdmin).toBe(true);

    // Old owner can no longer promote/demote anyone (owner-only path)
    const someone = await registerUser(app);
    const deny = await authed(app, owner.token)
      .patch(`/auth/users/${someone.user.id}`)
      .send({ isAdmin: true });
    expect(deny.status).toBe(403);
  });

  it("rejects non-owners (403)", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const target = await registerUser(app);

    const res = await authed(app, member.token)
      .post("/auth/transfer-ownership")
      .send({ targetUserId: target.user.id });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("owner_required");
  });

  it("refuses to transfer to a disabled user or to self", async () => {
    const owner = await registerUser(app);
    const disabled = await registerUser(app);
    await authed(app, owner.token)
      .patch(`/auth/users/${disabled.user.id}`)
      .send({ status: "disabled" });

    const toSelf = await authed(app, owner.token)
      .post("/auth/transfer-ownership")
      .send({ targetUserId: owner.user.id });
    expect(toSelf.status).toBe(400);
    expect(toSelf.body.error).toBe("already_owner");

    const toDisabled = await authed(app, owner.token)
      .post("/auth/transfer-ownership")
      .send({ targetUserId: disabled.user.id });
    expect(toDisabled.status).toBe(400);
    expect(toDisabled.body.error).toBe("target_disabled");
  });
});

describe("ensureOwner() self-heal", () => {
  it("promotes the oldest admin to owner if none exists", async () => {
    // Create two users by hand to simulate the pre-isOwner state:
    // both admins, neither owner.
    await registerUser(app); // owner+admin -> we'll strip ownership below
    const second = await registerUser(app);
    await prisma.user.update({
      where: { id: second.user.id },
      data: { isAdmin: true },
    });
    await prisma.user.updateMany({ data: { isOwner: false } });

    const fixed = await ensureOwner();
    expect(fixed).not.toBeNull();
    expect(fixed.isOwner).toBe(true);
    // Oldest admin wins -> it's the first one we created (the bootstrap).
    const owners = await prisma.user.findMany({ where: { isOwner: true } });
    expect(owners).toHaveLength(1);
  });
});
