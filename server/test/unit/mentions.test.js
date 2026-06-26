import { describe, it, expect } from "vitest";
import { isMentioned } from "../../src/socket.js";

const user = { username: "adrienc", displayName: "Adrien" };

describe("isMentioned", () => {
  it("is false on empty / nullish body", () => {
    expect(isMentioned(user, "")).toBe(false);
    expect(isMentioned(user, null)).toBe(false);
    expect(isMentioned(user, undefined)).toBe(false);
  });

  it("matches the username, case-insensitively", () => {
    expect(isMentioned(user, "salut @adrienc tu peux voir ?")).toBe(true);
    expect(isMentioned(user, "@ADRIENC ?")).toBe(true);
  });

  it("matches the display name too", () => {
    expect(isMentioned(user, "merci @Adrien")).toBe(true);
  });

  it("requires the @ sigil (a bare name is not a mention)", () => {
    expect(isMentioned(user, "adrienc a raison")).toBe(false);
  });

  it("is false when nobody is mentioned", () => {
    expect(isMentioned(user, "bonjour tout le monde")).toBe(false);
  });
});
