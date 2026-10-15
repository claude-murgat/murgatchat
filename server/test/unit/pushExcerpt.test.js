import { describe, it, expect } from "vitest";
import { pushExcerpt } from "../../src/socket.ts";

// Octets UTF-8 du texte une fois échappé dans le JSON de la charge utile.
const jsonBytes = (s) => Buffer.byteLength(JSON.stringify(s)) - 2;
const codePoints = (s) => Array.from(s).length;

describe("pushExcerpt", () => {
  it("keeps a message that fits as is", () => {
    expect(pushExcerpt("coucou")).toBe("coucou");
    const emojis = "😀".repeat(500); // 500 caractères, 2 000 octets : tient pile
    expect(pushExcerpt(emojis)).toBe(emojis);
  });

  it("cuts a long message to 500 characters, ellipsis included", () => {
    const out = pushExcerpt("a".repeat(10_000));
    expect(out).toBe("a".repeat(499) + "…");
  });

  it("drops trailing spaces before the ellipsis", () => {
    const out = pushExcerpt("a".repeat(498) + "  " + "b".repeat(100));
    expect(out).toBe("a".repeat(498) + "…");
  });

  it("never splits an emoji's surrogate pair", () => {
    const out = pushExcerpt("a" + "😀".repeat(1000));
    expect(out.isWellFormed()).toBe(true);
    expect(codePoints(out)).toBe(500);
    expect(out).toBe("a" + "😀".repeat(498) + "…");
  });

  it("bounds the JSON size even with characters JSON escapes (6 bytes each)", () => {
    const out = pushExcerpt("\u0001".repeat(1000));
    expect(out.endsWith("…")).toBe(true);
    expect(jsonBytes(out)).toBeLessThanOrEqual(2000);
    expect(codePoints(out)).toBeLessThan(500);
  });
});
