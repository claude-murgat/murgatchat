import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "../../src/index.ts";
import { ensureOwner } from "../../src/routes/auth.ts";
import { ensureBot } from "../../src/notify.ts";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";
import { seedMessage, seedReaction } from "../helpers/seed.js";

const UPLOAD_DIR = process.env.UPLOAD_DIR || "./.test-uploads";

// Upload a small file as `user` (encrypted blob on disk + Attachment row).
async function upload(user, name) {
  const res = await request(app)
    .post("/uploads")
    .set("Authorization", `Bearer ${user.token}`)
    .attach("file", Buffer.from(`contenu de ${name}`), name);
  return res.body.attachment;
}

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
    expect(res.body.total).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.hasMore).toBe(false);
    const owned = res.body.users.find((u) => u.id === owner.user.id);
    expect(owned.isOwner).toBe(true);
    expect(owned.isAdmin).toBe(true);
  });

  it("paginates with ?page & ?pageSize (clamped to ≤ 100)", async () => {
    const owner = await registerUser(app);
    // 4 extra members = 5 total (with the owner)
    for (let i = 0; i < 4; i++) await registerUser(app);

    const page1 = await authed(app, owner.token).get("/auth/users?page=1&pageSize=2");
    expect(page1.body.users).toHaveLength(2);
    expect(page1.body.total).toBe(5);
    expect(page1.body.hasMore).toBe(true);

    const page3 = await authed(app, owner.token).get("/auth/users?page=3&pageSize=2");
    expect(page3.body.users).toHaveLength(1);
    expect(page3.body.hasMore).toBe(false);

    // pageSize > 100 is clamped to 100
    const big = await authed(app, owner.token).get("/auth/users?pageSize=500");
    expect(big.body.pageSize).toBe(100);
  });

  it("filters by ?q on displayName / username / email (case insensitive)", async () => {
    const owner = await registerUser(app);
    const alice = await registerUser(app, {
      email: "alice.smith@e2e.local",
      username: "alice_s",
      displayName: "Alice Smith",
    });
    await registerUser(app, {
      email: "bob.jones@e2e.local",
      username: "bobby",
      displayName: "Bob Jones",
    });

    const byName = await authed(app, owner.token).get("/auth/users?q=ALICE");
    expect(byName.body.users.map((u) => u.id)).toEqual([alice.user.id]);

    const byUsername = await authed(app, owner.token).get("/auth/users?q=alice_s");
    expect(byUsername.body.users.map((u) => u.id)).toEqual([alice.user.id]);

    const byEmail = await authed(app, owner.token).get("/auth/users?q=jones");
    expect(byEmail.body.users.map((u) => u.username)).toEqual(["bobby"]);

    const nope = await authed(app, owner.token).get("/auth/users?q=nobody");
    expect(nope.body.users).toEqual([]);
    expect(nope.body.total).toBe(0);
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

  it("a disabled user can no longer fetch attachments with ?token= either", async () => {
    const owner = await registerUser(app);
    const victim = await registerUser(app);
    const att = await upload(victim, "photo.txt");
    const fetchAtt = () => request(app).get(`/uploads/${att.id}?token=${victim.token}`);
    expect((await fetchAtt()).status).toBe(200);

    await authed(app, owner.token)
      .patch(`/auth/users/${victim.user.id}`)
      .send({ status: "disabled" });

    expect((await fetchAtt()).status).toBe(401);
  });
});

describe("DELETE /auth/users/:id (permanent deletion)", () => {
  it("follows the disable permissions and only deletes an already-disabled account", async () => {
    const owner = await registerUser(app);
    const admin = await registerUser(app);
    const adminTwo = await registerUser(app);
    const member = await registerUser(app);
    const victim = await registerUser(app);
    const asOwner = authed(app, owner.token);
    for (const a of [admin, adminTwo]) {
      await asOwner.patch(`/auth/users/${a.user.id}`).send({ isAdmin: true });
    }
    await asOwner.patch(`/auth/users/${adminTwo.user.id}`).send({ status: "disabled" });
    await asOwner.patch(`/auth/users/${victim.user.id}`).send({ status: "disabled" });

    expect(
      (await authed(app, member.token).delete(`/auth/users/${victim.user.id}`)).status
    ).toBe(403);

    // Still active: disabling first is mandatory (two steps for an irreversible purge).
    const active = await asOwner.delete(`/auth/users/${member.user.id}`);
    expect(active.status).toBe(409);
    expect(active.body.error).toBe("must_disable_first");

    const onAdmin = await authed(app, admin.token).delete(`/auth/users/${adminTwo.user.id}`);
    expect(onAdmin.status).toBe(403);
    expect(onAdmin.body.error).toBe("owner_required_for_admin");

    const onOwner = await authed(app, admin.token).delete(`/auth/users/${owner.user.id}`);
    expect(onOwner.status).toBe(403);
    expect(onOwner.body.error).toBe("owner_protected");

    expect((await asOwner.delete("/auth/users/does-not-exist")).status).toBe(404);

    // An admin deletes a disabled member; only the owner deletes a disabled admin.
    expect((await authed(app, admin.token).delete(`/auth/users/${victim.user.id}`)).status).toBe(200);
    expect((await asOwner.delete(`/auth/users/${adminTwo.user.id}`)).status).toBe(200);
    const gone = await prisma.user.count({
      where: { id: { in: [victim.user.id, adminTwo.user.id] } },
    });
    expect(gone).toBe(0);
  });

  it("protects the bot account and keeps it out of the admin list", async () => {
    const owner = await registerUser(app);
    const bot = await ensureBot();
    await prisma.user.update({ where: { id: bot.id }, data: { status: "disabled" } });

    const res = await authed(app, owner.token).delete(`/auth/users/${bot.id}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bot_protected");

    const list = await authed(app, owner.token).get("/auth/users");
    expect(list.body.users.map((u) => u.id)).toEqual([owner.user.id]);
    expect(list.body.total).toBe(1);
  });

  it("purges the account and what only it owned, keeping what the others wrote", async () => {
    const owner = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);
    const as = (u) => authed(app, u.token);

    // Shared channel: bob's message (with a file), carol's reply to it, and an
    // owner message bob reacted to.
    const projet = (
      await as(owner)
        .post("/channels")
        .send({ name: "projet", memberIds: [bob.user.id, carol.user.id] })
    ).body.channel;
    const file = await upload(bob, "plan.txt");
    const bobMsg = await seedMessage({ channelId: projet.id, authorId: bob.user.id, body: "mon plan" });
    await prisma.attachment.update({ where: { id: file.id }, data: { messageId: bobMsg.id } });
    const reply = await seedMessage({
      channelId: projet.id,
      authorId: carol.user.id,
      body: "bien vu",
      parentId: bobMsg.id,
    });
    const ownerMsg = await seedMessage({ channelId: projet.id, authorId: owner.user.id, body: "go" });
    await seedReaction({ messageId: ownerMsg.id, userId: bob.user.id, emoji: "👍" });
    // An upload bob never sent.
    const draft = await upload(bob, "brouillon.txt");

    // Conversations: 1-to-1 DM, bob's own notes, a group DM, an expert conversation.
    const dm = (await as(carol).post("/channels/dm").send({ userIds: [bob.user.id] })).body.channel;
    await seedMessage({ channelId: dm.id, authorId: carol.user.id, body: "salut bob" });
    const notes = (await as(bob).post("/channels/dm").send({ userIds: [] })).body.channel;
    const group = (
      await as(carol).post("/channels/dm").send({ userIds: [bob.user.id, owner.user.id] })
    ).body.channel;
    const bot = await ensureBot();
    const expert = await prisma.channel.create({
      data: {
        kind: "claude",
        isPrivate: true,
        name: "Expert",
        memberships: { create: [{ userId: bob.user.id }, { userId: bot.id }] },
      },
    });

    // What outlives its author: bob's bug report and the invitations bob sent.
    const report = await prisma.bugReport.create({ data: { userId: bob.user.id, message: "ça plante" } });
    const invite = await prisma.invitation.create({
      data: {
        email: "recrue@test.local",
        token: "tok-recrue",
        invitedBy: bob.user.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const blobs = (
      await prisma.attachment.findMany({ where: { id: { in: [file.id, draft.id] } } })
    ).map((a) => path.join(UPLOAD_DIR, a.storagePath));
    expect(blobs.every((p) => fs.existsSync(p))).toBe(true);

    await as(owner).patch(`/auth/users/${bob.user.id}`).send({ status: "disabled" });
    expect((await as(owner).delete(`/auth/users/${bob.user.id}`)).status).toBe(200);

    expect(await prisma.user.findUnique({ where: { id: bob.user.id } })).toBeNull();
    // bob's messages and reactions are gone; carol's reply survives, unquoted.
    expect(await prisma.message.findUnique({ where: { id: bobMsg.id } })).toBeNull();
    expect((await prisma.message.findUnique({ where: { id: reply.id } })).parentId).toBeNull();
    expect(await prisma.message.findUnique({ where: { id: ownerMsg.id } })).not.toBeNull();
    expect(await prisma.reaction.count({ where: { messageId: ownerMsg.id } })).toBe(0);

    // Two-member conversations disappear whole; the others just lose a member.
    const doomed = await prisma.channel.count({
      where: { id: { in: [dm.id, notes.id, expert.id] } },
    });
    expect(doomed).toBe(0);
    const membersOf = async (channelId) =>
      (await prisma.membership.findMany({ where: { channelId } })).map((m) => m.userId).sort();
    const survivors = [owner.user.id, carol.user.id].sort();
    expect(await membersOf(projet.id)).toEqual(survivors);
    expect(await membersOf(group.id)).toEqual(survivors);

    // Files: rows and encrypted blobs.
    expect(await prisma.attachment.count({ where: { id: { in: [file.id, draft.id] } } })).toBe(0);
    expect(blobs.some((p) => fs.existsSync(p))).toBe(false);

    expect((await prisma.bugReport.findUnique({ where: { id: report.id } })).userId).toBeNull();
    expect((await prisma.invitation.findUnique({ where: { id: invite.id } })).invitedBy).toBe(
      owner.user.id
    );
    // The address is free again: it can be re-invited.
    expect((await as(owner).post("/auth/invitations").send({ email: bob.user.email })).status).toBe(
      200
    );
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
    await registerUser(app); // bootstrap owner (first account) — the guard being tested
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
