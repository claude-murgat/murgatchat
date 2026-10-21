import { describe, it, expect } from "vitest";
import { signReadToken, verifyReadToken } from "../../src/pushReadToken.ts";

const claims = { userId: "cmuser123", channelId: "cmchan456", createdAt: 1_760_000_000_123 };

describe("jeton de lecture des Web Push", () => {
  it("restitue ce qu'il signe", () => {
    expect(verifyReadToken(signReadToken(claims))).toEqual(claims);
  });

  it("refuse un jeton dont le contenu a été modifié", () => {
    const [, sig] = signReadToken(claims).split(".");
    const forged = Buffer.from("autreuser.cmchan456.1760000000123").toString("base64url");
    expect(verifyReadToken(`${forged}.${sig}`)).toBeNull();
  });

  it("refuse une signature altérée et les entrées mal formées", () => {
    const token = signReadToken(claims);
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyReadToken(flipped)).toBeNull();
    for (const bad of [undefined, null, 42, "", "abc", "a.b.c", `${token}.x`, "x".repeat(400)]) {
      expect(verifyReadToken(bad)).toBeNull();
    }
  });
});
