import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
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

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GIPHY_API_KEY;
});

// A tiny but valid-looking GIF payload (header bytes are enough — we never decode).
const FAKE_GIF = Buffer.from("GIF89a" + "x".repeat(64), "binary");
function fakeFetch(body, { contentType = "image/gif", ok = true } = {}) {
  return vi.fn(async () => ({
    ok,
    headers: {
      get: (h) => {
        const k = h.toLowerCase();
        if (k === "content-type") return contentType;
        if (k === "content-length") return String(body.length);
        return null;
      },
    },
    json: async () => JSON.parse(body.toString()),
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  }));
}

describe("GET /gifs/search", () => {
  it("requires auth", async () => {
    const r = await request(app).get("/gifs/search?q=cat");
    expect(r.status).toBe(401);
  });

  it("reports not_configured when no API key is set", async () => {
    const { token } = await registerUser(app);
    const r = await authed(app, token).get("/gifs/search?q=cat");
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("not_configured");
  });

  it("maps GIPHY results to {previewUrl, fullUrl, …} when configured", async () => {
    const { token } = await registerUser(app);
    process.env.GIPHY_API_KEY = "test-key";
    const payload = Buffer.from(
      JSON.stringify({
        data: [
          {
            id: "abc",
            title: "a cat",
            images: {
              fixed_width: { url: "https://media.giphy.com/p.gif", width: "200", height: "150" },
              original: { url: "https://media.giphy.com/o.gif", width: "480", height: "360" },
            },
          },
        ],
        pagination: { offset: 0, count: 1, total_count: 1 },
      })
    );
    vi.stubGlobal("fetch", fakeFetch(payload));

    const r = await authed(app, token).get("/gifs/search?q=cat");
    expect(r.status).toBe(200);
    expect(r.body.gifs).toHaveLength(1);
    expect(r.body.gifs[0]).toMatchObject({
      id: "abc",
      previewUrl: "https://media.giphy.com/p.gif",
      fullUrl: "https://media.giphy.com/o.gif",
      width: 480,
      height: 360,
    });
    expect(r.body.nextPos).toBe(1);
  });
});

describe("POST /gifs/import", () => {
  it("requires auth", async () => {
    const r = await request(app)
      .post("/gifs/import")
      .send({ url: "https://media.giphy.com/o.gif" });
    expect(r.status).toBe(401);
  });

  it("rejects a non-GIPHY URL (SSRF guard)", async () => {
    const { token } = await registerUser(app);
    for (const url of [
      "https://evil.example.com/x.gif",
      "http://media.giphy.com/o.gif", // not https
      "https://giphy.com.evil.com/x.gif",
      "file:///etc/passwd",
      "not a url",
    ]) {
      const r = await authed(app, token).post("/gifs/import").send({ url });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_gif_url");
    }
  });

  it("re-hosts a GIPHY gif as an encrypted attachment, downloadable afterwards", async () => {
    const { token } = await registerUser(app);
    vi.stubGlobal("fetch", fakeFetch(FAKE_GIF));

    const imp = await authed(app, token)
      .post("/gifs/import")
      .send({ url: "https://media.giphy.com/media/abc/giphy.gif" });
    expect(imp.status).toBe(200);
    expect(imp.body.attachment.id).toBeTruthy();
    expect(imp.body.attachment.mimeType).toBe("image/gif");
    expect(imp.body.attachment.size).toBe(FAKE_GIF.length);

    // The stored blob decrypts + serves back through the normal upload route.
    const dl = await authed(app, token).get(`/uploads/${imp.body.attachment.id}`);
    expect(dl.status).toBe(200);
    expect(dl.headers["content-type"]).toBe("image/gif");
    expect(dl.headers["content-length"]).toBe(String(FAKE_GIF.length));
  });
});
