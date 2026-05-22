import { describe, it, expect, vi } from "vitest";
import { encryptBody, decryptBody } from "../../src/crypto.js";

describe("crypto", () => {
  it("round-trips an encrypted message", () => {
    const plain = "Bonjour le monde ✨";
    const stored = encryptBody(plain);
    expect(stored.startsWith("enc1:")).toBe(true);
    expect(stored).not.toContain(plain);
    expect(decryptBody(stored)).toBe(plain);
  });

  it("uses a fresh IV each time (ciphertext differs, plaintext matches)", () => {
    const a = encryptBody("same text");
    const b = encryptBody("same text");
    expect(a).not.toBe(b);
    expect(decryptBody(a)).toBe("same text");
    expect(decryptBody(b)).toBe("same text");
  });

  it("returns legacy plaintext unchanged (no enc1: prefix)", () => {
    expect(decryptBody("ancien message en clair")).toBe("ancien message en clair");
  });

  it("returns a placeholder for corrupted ciphertext", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(decryptBody("enc1:not-valid-base64-or-tag")).toBe("[message non déchiffrable]");
    spy.mockRestore();
  });

  it("coerces non-strings and handles empty input", () => {
    expect(decryptBody(encryptBody(""))).toBe("");
    expect(decryptBody(encryptBody(null))).toBe("");
    expect(decryptBody(123)).toBe(123); // non-string passes through
  });
});
