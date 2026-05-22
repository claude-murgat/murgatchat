import request from "supertest";

let seq = 0;

// Register a fresh user through the real endpoint and return { token, user }.
// Unique email/username each call so it survives even without a DB reset.
export async function registerUser(app, overrides = {}) {
  seq += 1;
  const tag = `${Date.now().toString(36)}${seq}`;
  const input = {
    email: overrides.email ?? `u_${tag}@test.local`,
    username: overrides.username ?? `u_${tag}`,
    displayName: overrides.displayName ?? `User ${tag}`,
    password: overrides.password ?? "test1234",
  };
  const res = await request(app).post("/auth/register").send(input);
  if (res.status !== 200) {
    throw new Error(`registerUser failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return { token: res.body.token, user: res.body.user, input };
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
