import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encryptBufferToFile, decryptFile, BLOB_VERSION } from "../../src/cryptoFile.js";

function tmp() {
  return path.join(os.tmpdir(), `mc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("cryptoFile (AES-256-GCM stream-encrypt / decrypt)", () => {
  it("round-trips arbitrary binary content", async () => {
    const plaintext = Buffer.concat([
      Buffer.from("hello "),
      Buffer.from([0, 1, 2, 3, 0xff]),
      Buffer.alloc(1024, 0xab),
    ]);
    const p = tmp();
    await encryptBufferToFile(plaintext, p);
    const out = await decryptFile(p);
    expect(out.equals(plaintext)).toBe(true);
    fs.unlinkSync(p);
  });

  it("writes a header with the version + IV and an auth tag at the end", async () => {
    const p = tmp();
    await encryptBufferToFile(Buffer.from("a"), p);
    const blob = fs.readFileSync(p);
    expect(blob[0]).toBe(BLOB_VERSION); // version marker
    expect(blob.length).toBeGreaterThanOrEqual(1 + 12 + 1 + 16); // header + ct + tag
    fs.unlinkSync(p);
  });

  it("rejects a tampered ciphertext with a GCM tag failure", async () => {
    const p = tmp();
    await encryptBufferToFile(Buffer.from("immutable"), p);
    const blob = fs.readFileSync(p);
    blob[blob.length - 17] ^= 0x01; // flip a byte in the ciphertext
    fs.writeFileSync(p, blob);
    await expect(decryptFile(p)).rejects.toThrow();
    fs.unlinkSync(p);
  });

  it("rejects a blob with an unknown version byte", async () => {
    const p = tmp();
    await encryptBufferToFile(Buffer.from("x"), p);
    const blob = fs.readFileSync(p);
    blob[0] = 0xff;
    fs.writeFileSync(p, blob);
    await expect(decryptFile(p)).rejects.toThrow(/unknown_blob_version/);
    fs.unlinkSync(p);
  });
});
