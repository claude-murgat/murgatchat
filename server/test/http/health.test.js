import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createServer } from "../../src/index.js";
import { registerUser } from "../helpers/api.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

describe("GET /health", () => {
  it("reports needsBootstrap=true on an empty DB", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, needsBootstrap: true });
  });

  it("reports needsBootstrap=false once at least one user exists", async () => {
    await registerUser(app);
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, needsBootstrap: false });
  });

  it("does not require auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });
});
