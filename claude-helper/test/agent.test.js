import { describe, it, expect, afterEach } from "vitest";
import { expertModel } from "../src/agent.ts";

afterEach(() => {
  delete process.env.EXPERT_MODEL;
});

describe("modèle des experts", () => {
  it("Sonnet par défaut : rapide, suffisant pour renseigner vite", () => {
    expect(expertModel()).toBe("sonnet");
  });

  it("surchargeable via EXPERT_MODEL", () => {
    process.env.EXPERT_MODEL = "opus";
    expect(expertModel()).toBe("opus");
  });

  it("une variable vide retombe sur Sonnet", () => {
    process.env.EXPERT_MODEL = "   ";
    expect(expertModel()).toBe("sonnet");
  });
});
