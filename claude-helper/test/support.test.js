import { describe, it, expect } from "vitest";
import { flattenTranscript } from "../src/support.ts";

describe("flattenTranscript", () => {
  it("un seul message → le message tel quel", () => {
    expect(flattenTranscript([{ role: "user", content: "ça plante" }])).toBe("ça plante");
  });

  it("historique lisible + dernier message isolé", () => {
    const out = flattenTranscript([
      { role: "user", content: "ça plante" },
      { role: "assistant", content: "Sur quelle plateforme ?" },
      { role: "user", content: "sur le desktop" },
    ]);
    expect(out).toContain("[Historique de la conversation]");
    expect(out).toContain("Utilisateur : ça plante");
    expect(out).toContain("Assistant : Sur quelle plateforme ?");
    expect(out).toMatch(/Nouveau message de l'utilisateur :\nsur le desktop$/);
    // le dernier message n'est pas dupliqué dans l'historique
    expect(out.split("sur le desktop").length).toBe(2);
  });
});
