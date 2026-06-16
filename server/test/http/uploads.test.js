import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "../../src/index.js";
import { registerUser } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";

// supertest auto-parses by Content-Type. Force raw bytes so we can compare
// the downloaded payload to the original buffer regardless of MIME.
function rawBytes(req) {
  return req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
}

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

const UPLOAD_DIR = process.env.UPLOAD_DIR || "./.test-uploads";

beforeEach(() => {
  if (fs.existsSync(UPLOAD_DIR)) {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch { /* dir may be empty */ }
    }
  }
});

describe("POST /uploads + GET /uploads/:id", () => {
  it("encrypts the blob on disk and decrypts it for the authorized reader", async () => {
    const { token, user } = await registerUser(app);
    const secret = "top secret content " + Math.random().toString(36);

    const up = await request(app)
      .post("/uploads")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from(secret), "secret.txt");
    expect(up.status).toBe(200);
    expect(up.body.attachment.size).toBe(Buffer.byteLength(secret));

    const att = await prisma.attachment.findUnique({ where: { id: up.body.attachment.id } });
    expect(att.encrypted).toBe(true);

    // The on-disk blob must NOT contain the plaintext (sanity-check the crypto).
    const blob = fs.readFileSync(path.join(UPLOAD_DIR, att.storagePath));
    expect(blob.toString("utf8")).not.toContain(secret);
    expect(blob.length).toBeGreaterThan(Buffer.byteLength(secret)); // header + tag overhead

    // Download as the uploader gets the original bytes back.
    const dl = await rawBytes(request(app).get(`/uploads/${att.id}?token=${token}`));
    expect(dl.status).toBe(200);
    expect(dl.body.toString("utf8")).toBe(secret);
    expect(dl.headers["content-type"]).toBe("text/plain");
    expect(dl.headers["content-length"]).toBe(String(Buffer.byteLength(secret)));
    // sanity: user was the uploader
    expect(att.uploadedBy).toBe(user.id);
  });

  it("serves inline by default and as an attachment with ?download=1", async () => {
    const { token } = await registerUser(app);
    const up = await request(app)
      .post("/uploads")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("hello"), "rapport final.pdf");
    const id = up.body.attachment.id;

    const inline = await request(app).get(`/uploads/${id}?token=${token}`);
    expect(inline.headers["content-disposition"]).toMatch(/^inline;/);

    const dl = await request(app).get(`/uploads/${id}?token=${token}&download=1`);
    expect(dl.status).toBe(200);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment;/);
    // The real (UTF-8, spaced) filename is preserved in the header either way.
    expect(dl.headers["content-disposition"]).toContain(
      `filename*=UTF-8''${encodeURIComponent("rapport final.pdf")}`
    );
  });

  it("falls back to raw streaming for legacy un-encrypted blobs", async () => {
    const { token, user } = await registerUser(app);
    const storagePath = "legacy-uploads-test.bin";
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, storagePath), "plain old bytes");

    const att = await prisma.attachment.create({
      data: {
        uploadedBy: user.id,
        filename: "legacy.txt",
        mimeType: "text/plain",
        size: 15,
        storagePath,
        encrypted: false,
      },
    });

    const dl = await rawBytes(request(app).get(`/uploads/${att.id}?token=${token}`));
    expect(dl.status).toBe(200);
    expect(dl.body.toString("utf8")).toBe("plain old bytes");
  });

  it("rejects an unauthenticated download", async () => {
    const { token, user } = await registerUser(app);
    const up = await request(app)
      .post("/uploads")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("x"), "x.txt");
    const dl = await request(app).get(`/uploads/${up.body.attachment.id}`);
    expect(dl.status).toBe(401);
    expect(user.id).toBeDefined();
  });
});
