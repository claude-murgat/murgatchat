import { describe, it, expect, afterEach } from "vitest";
import { workspaceFor, knownExperts } from "../src/experts.ts";

afterEach(() => {
  delete process.env.WORKSPACE;
  delete process.env.WORKSPACE_MANAGEMENT;
  delete process.env.WORKSPACE_MON_EXPERT;
});

describe("résolution expert → workspace", () => {
  it("supervision = WORKSPACE (défaut historique), aussi sans clé", () => {
    expect(workspaceFor("supervision")).toBe("/home/murgat/claude-helper");
    expect(workspaceFor(undefined)).toBe("/home/murgat/claude-helper");
    process.env.WORKSPACE = "/tmp/sup";
    expect(workspaceFor("supervision")).toBe("/tmp/sup");
  });

  it("un autre expert exige sa variable WORKSPACE_<CLÉ> — sinon null, jamais un repli", () => {
    expect(workspaceFor("management")).toBeNull();
    process.env.WORKSPACE_MANAGEMENT = "/home/murgat/claude-management";
    expect(workspaceFor("management")).toBe("/home/murgat/claude-management");
    process.env.WORKSPACE_MON_EXPERT = "/tmp/x";
    expect(workspaceFor("mon-expert")).toBe("/tmp/x");
  });

  it("refuse les clés mal formées (pas de traversée par l'environnement)", () => {
    for (const bad of ["", "Management", "../x", "a b", "PATH", "x".repeat(40)]) {
      expect(workspaceFor(bad || "-")).toBeNull();
    }
  });

  it("liste les experts servis d'après l'environnement", () => {
    expect(knownExperts()).toEqual(["supervision"]);
    process.env.WORKSPACE_MANAGEMENT = "/home/murgat/claude-management";
    expect(knownExperts().sort()).toEqual(["management", "supervision"]);
  });
});
