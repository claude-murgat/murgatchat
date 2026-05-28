import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createServer } from "../../src/index.js";
import { registerUser, authed } from "../helpers/api.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

describe("PATCH /auth/me (profile)", () => {
  it("updates the display name", async () => {
    const { token, user } = await registerUser(app, { displayName: "Old Name" });
    const res = await authed(app, token).patch("/auth/me").send({ displayName: "Brand New" });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.displayName).toBe("Brand New");
  });

  it("changes the password when the current password is correct", async () => {
    const { token, input } = await registerUser(app, { password: "current123" });
    const res = await authed(app, token)
      .patch("/auth/me")
      .send({ currentPassword: "current123", newPassword: "new98765" });
    expect(res.status).toBe(200);

    // Old password rejected, new one accepted.
    const old = await request(app)
      .post("/auth/login")
      .send({ emailOrUsername: input.email, password: "current123" });
    expect(old.status).toBe(401);
    const fresh = await request(app)
      .post("/auth/login")
      .send({ emailOrUsername: input.email, password: "new98765" });
    expect(fresh.status).toBe(200);
  });

  it("rejects a wrong current password with 403", async () => {
    const { token } = await registerUser(app, { password: "current123" });
    const res = await authed(app, token)
      .patch("/auth/me")
      .send({ currentPassword: "wrongone", newPassword: "newnew99" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invalid_current_password");
  });

  it("requires the current password to change the password (400)", async () => {
    const { token } = await registerUser(app);
    const res = await authed(app, token).patch("/auth/me").send({ newPassword: "newnew99" });
    expect(res.status).toBe(400);
  });

  it("rejects an empty patch (400)", async () => {
    const { token } = await registerUser(app);
    const res = await authed(app, token).patch("/auth/me").send({});
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated calls with 401", async () => {
    const res = await request(app).patch("/auth/me").send({ displayName: "anon" });
    expect(res.status).toBe(401);
  });

  it("validates the new password length (400)", async () => {
    const { token } = await registerUser(app, { password: "current123" });
    const res = await authed(app, token)
      .patch("/auth/me")
      .send({ currentPassword: "current123", newPassword: "shrt" });
    expect(res.status).toBe(400);
  });
});
