import { describe, it, expect, vi, afterEach } from "vitest";
import {
  anthropicEnabled,
  runSupportTurn,
  diagnosticContext,
} from "../../src/anthropic.ts";

const messages = [{ role: "user", content: "ça plante" }];

describe("anthropicEnabled", () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.SUPPORT_RELAY_URL;
    delete process.env.CLAUDE_HELPER_TOKEN;
  });

  it("reflects presence of ANTHROPIC_API_KEY", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(anthropicEnabled()).toBe(false);
    process.env.ANTHROPIC_API_KEY = "k";
    expect(anthropicEnabled()).toBe(true);
  });

  it("est aussi actif avec le relais seul (URL + secret du pont)", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.SUPPORT_RELAY_URL = "http://helper.test:7070";
    expect(anthropicEnabled()).toBe(false); // secret manquant
    process.env.CLAUDE_HELPER_TOKEN = "s";
    expect(anthropicEnabled()).toBe(true);
  });
});

describe("diagnosticContext", () => {
  it("is empty when nothing is attached", () => {
    expect(diagnosticContext()).toBe("");
    expect(diagnosticContext({})).toBe("");
  });

  it("formats platform/version/diagnostics and a logs tail, without duplicating keys", () => {
    const block = diagnosticContext({
      platform: "pwa",
      appVersion: "1.2.3",
      diagnostics: { platform: "pwa", appVersion: "1.2.3", screen: "390x844" },
      logs: "ligne de log",
    });
    expect(block).toContain("Plateforme : pwa");
    expect(block).toContain("Version de l'app : 1.2.3");
    expect(block).toContain("screen : 390x844");
    expect(block).toContain("ligne de log");
    // platform/appVersion appear once (header), not repeated from the diag object.
    expect(block.match(/Plateforme : pwa/g)).toHaveLength(1);
  });

  it("truncates an oversized logs tail", () => {
    const block = diagnosticContext({ logs: "x".repeat(10000) });
    expect(block).toContain("début tronqué");
    expect(block.length).toBeLessThan(6000);
  });
});

describe("runSupportTurn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("is a no-op (null, no HTTP) when disabled", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await runSupportTurn(messages)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the assistant text and no finalize for a clarifying turn", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "Sur quelle plateforme ?" }],
          stop_reason: "end_turn",
        }),
      })
    );
    const turn = await runSupportTurn(messages);
    expect(turn.reply).toBe("Sur quelle plateforme ?");
    expect(turn.finalize).toBeNull();
  });

  it("extracts the submit_ticket tool input when Claude finalizes", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [
            { type: "text", text: "Merci, je transmets." },
            {
              type: "tool_use",
              name: "submit_ticket",
              input: { title: "Bug salon", body: "Résumé du bug", severity: "moyenne" },
            },
          ],
          stop_reason: "tool_use",
        }),
      })
    );
    const turn = await runSupportTurn(messages);
    expect(turn.finalize).toEqual({
      title: "Bug salon",
      body: "Résumé du bug",
      severity: "moyenne",
    });
    expect(turn.reply).toBe("Merci, je transmets.");
  });

  it("falls back to a default reply when finalize carries no text", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [
            { type: "tool_use", name: "submit_ticket", input: { title: "x", body: "y" } },
          ],
          stop_reason: "tool_use",
        }),
      })
    );
    const turn = await runSupportTurn(messages);
    expect(turn.finalize).toEqual({ title: "x", body: "y" });
    expect(turn.reply.length).toBeGreaterThan(0);
  });

  it("injects the attached diagnostics into the system prompt sent to the API", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await runSupportTurn(messages, {
      platform: "web",
      appVersion: "0.6.1",
      diagnostics: { socket: "connected", locale: "fr-FR" },
      logs: "12:00 [error] boom",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.system).toContain("Plateforme : web");
    expect(body.system).toContain("Version de l'app : 0.6.1");
    expect(body.system).toContain("socket : connected");
    expect(body.system).toContain("boom"); // logs tail
    expect(body.system).toContain("NE REDEMANDE PAS");
    // The diagnostic stays out of the transcript.
    expect(JSON.stringify(body.messages)).not.toContain("Plateforme : web");
  });

  it("returns null on a non-ok response", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "bad key" })
    );
    expect(await runSupportTurn(messages)).toBeNull();
  });

  it("returns null (swallows) when the request throws", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await runSupportTurn(messages)).toBeNull();
  });
});

describe("runSupportTurn — relais claude-helper", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.SUPPORT_RELAY_URL;
    delete process.env.CLAUDE_HELPER_TOKEN;
  });

  function enableRelay() {
    process.env.SUPPORT_RELAY_URL = "http://helper.test:7070";
    process.env.CLAUDE_HELPER_TOKEN = "relay-secret";
  }

  it("poste system + transcript au relais, authentifié, et relaie reply/finalize", async () => {
    enableRelay();
    process.env.ANTHROPIC_API_KEY = "k"; // présent mais le relais prime
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        reply: "Merci, je transmets.",
        finalize: { title: "Bug salon", body: "Résumé", severity: "moyenne" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const turn = await runSupportTurn(messages, { platform: "pwa" });
    expect(turn.reply).toBe("Merci, je transmets.");
    expect(turn.finalize).toEqual({ title: "Bug salon", body: "Résumé", severity: "moyenne" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://helper.test:7070/support-turn");
    expect(init.headers.Authorization).toBe("Bearer relay-secret");
    const body = JSON.parse(init.body);
    expect(body.messages).toEqual(messages);
    expect(body.system).toContain("Plateforme : pwa"); // diagnostics dans le system
  });

  it("réponse par défaut quand le relais finalise sans texte", async () => {
    enableRelay();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ reply: "", finalize: { title: "T", body: "B" } }),
      })
    );
    const turn = await runSupportTurn(messages);
    expect(turn.finalize).toEqual({ title: "T", body: "B" });
    expect(turn.reply).toMatch(/transmets/);
  });

  it("null (repli) quand le relais répond en erreur ou est injoignable", async () => {
    enableRelay();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => "boom" }));
    expect(await runSupportTurn(messages)).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await runSupportTurn(messages)).toBeNull();
  });
});
