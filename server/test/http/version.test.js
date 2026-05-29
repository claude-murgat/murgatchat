import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createServer } from "../../src/index.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

describe("GET /version", () => {
  it("returns a version and a download URL, without auth", async () => {
    const res = await request(app).get("/version");
    expect(res.status).toBe(200);
    expect(typeof res.body.version).toBe("string");
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/); // semver-ish
    expect(res.body.downloadUrl).toMatch(/^https?:\/\//);
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });

  it("reflects CLIENT_VERSION when set", async () => {
    // vitest.config injects env per worker; we assert the shape is driven by env
    // by checking it equals process.env.CLIENT_VERSION when that is defined,
    // otherwise just that it's a non-empty string (package fallback).
    const res = await request(app).get("/version");
    if (process.env.CLIENT_VERSION) {
      expect(res.body.version).toBe(process.env.CLIENT_VERSION);
    } else {
      expect(res.body.version.length).toBeGreaterThan(0);
    }
  });
});
