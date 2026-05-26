import request from "supertest";
import { prisma } from "./db.js";
import { signToken } from "../../src/auth.js";

let seq = 0;

async function postRegister(app, input, token) {
  const res = await request(app)
    .post("/auth/register")
    .send(token ? { ...input, token } : input);
  if (res.status !== 200) {
    throw new Error(`registerUser failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return { token: res.body.token, user: res.body.user, input };
}

// Register a user, transparently handling invitation-only mode: the first user
// (empty DB) bootstraps as admin; every subsequent user is invited by an existing
// admin (token minted directly, then registered with the invitation token).
export async function registerUser(app, overrides = {}) {
  seq += 1;
  const tag = `u_${Date.now().toString(36)}${seq}`.slice(0, 30);
  const input = {
    email: (overrides.email ?? `${tag}@test.local`).toLowerCase(),
    username: overrides.username ?? tag,
    displayName: overrides.displayName ?? `User ${tag}`,
    password: overrides.password ?? "test1234",
  };

  if ((await prisma.user.count()) === 0) {
    return postRegister(app, input, null); // bootstrap = admin, no invitation
  }

  const admin = await prisma.user.findFirst({ where: { isAdmin: true } });
  if (!admin) throw new Error("registerUser: no admin available to invite");
  const invite = await request(app)
    .post("/auth/invitations")
    .set("Authorization", `Bearer ${signToken(admin)}`)
    .send({ email: input.email });
  if (invite.status !== 200) {
    throw new Error(`invite failed (${invite.status}): ${JSON.stringify(invite.body)}`);
  }
  return postRegister(app, input, invite.body.token);
}

// supertest request with the Authorization header pre-applied.
export function authed(app, token) {
  const agent = request(app);
  const wrap = (method) => (url) => agent[method](url).set("Authorization", `Bearer ${token}`);
  return {
    get: wrap("get"),
    post: wrap("post"),
    patch: wrap("patch"),
    delete: wrap("delete"),
  };
}
