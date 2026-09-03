import { describe, it, expect, afterEach } from "vitest";
import { claudeExpertEnabled, callbackTokenMatches } from "../../src/claudeHelper.ts";

afterEach(() => {
  delete process.env.CLAUDE_HELPER_URL;
  delete process.env.CLAUDE_HELPER_TOKEN;
  delete process.env.CLAUDE_CALLBACK_TOKEN;
});

describe("claudeExpertEnabled", () => {
  it("exige les TROIS variables — l'une vide = pont off", () => {
    expect(claudeExpertEnabled()).toBe(false);
    process.env.CLAUDE_HELPER_URL = "http://helper.local:7070";
    expect(claudeExpertEnabled()).toBe(false);
    process.env.CLAUDE_HELPER_TOKEN = "a";
    expect(claudeExpertEnabled()).toBe(false);
    process.env.CLAUDE_CALLBACK_TOKEN = "b";
    expect(claudeExpertEnabled()).toBe(true);
  });
});

describe("callbackTokenMatches", () => {
  it("accepte le bon secret, refuse le mauvais, le vide et l'absent", () => {
    process.env.CLAUDE_CALLBACK_TOKEN = "s3cret";
    expect(callbackTokenMatches("s3cret")).toBe(true);
    expect(callbackTokenMatches("s3creT")).toBe(false);
    expect(callbackTokenMatches("s3cret-mais-plus-long")).toBe(false);
    expect(callbackTokenMatches("")).toBe(false);
  });

  it("refuse tout quand aucun secret n'est configuré (y compris la chaîne vide)", () => {
    delete process.env.CLAUDE_CALLBACK_TOKEN;
    expect(callbackTokenMatches("")).toBe(false);
    expect(callbackTokenMatches("nimporte")).toBe(false);
  });
});
