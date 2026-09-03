import { describe, it, expect, vi, beforeEach } from "vitest";

// La file est testée avec un cerveau et un callback factices : on ne veut ici
// que la mécanique (sérialisation par conversation, fusion du buffer, cap).
vi.mock("../src/agent.ts", () => ({ runTurn: vi.fn() }));
vi.mock("../src/callback.ts", () => ({ sendCallback: vi.fn(async () => {}) }));

const { runTurn } = await import("../src/agent.ts");
const { sendCallback } = await import("../src/callback.ts");
const { enqueueTurn, queueDepth } = await import("../src/queue.ts");

const flush = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  runTurn.mockReset();
  sendCallback.mockReset();
  sendCallback.mockResolvedValue(undefined);
});

describe("file des tours", () => {
  it("sérialise par conversation : les messages arrivés pendant un tour sont fusionnés dans le suivant", async () => {
    let release;
    runTurn.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ ok: true, reply: "r1" })))
    );
    runTurn.mockResolvedValueOnce({ ok: true, reply: "r2" });

    expect(enqueueTurn("conv-a", "premier", "Alice")).toBe(true);
    await flush();
    expect(runTurn).toHaveBeenCalledTimes(1);

    // Deux messages pendant que le tour 1 tourne → UN seul tour 2, fusionné.
    enqueueTurn("conv-a", "deuxième", "Alice");
    enqueueTurn("conv-a", "troisième", "Bob");
    await flush();
    expect(runTurn).toHaveBeenCalledTimes(1); // toujours en cours

    release();
    await flush();
    expect(runTurn).toHaveBeenCalledTimes(2);
    const merged = runTurn.mock.calls[1][1];
    expect(merged).toContain("deuxième");
    expect(merged).toContain("[Bob] troisième");
    expect(sendCallback).toHaveBeenCalledTimes(2);
    expect(queueDepth()).toBe(0);
  });

  it("refuse au-delà de 20 messages bufferisés sur une conversation", async () => {
    let release;
    runTurn.mockImplementation(
      () => new Promise((r) => (release = () => r({ ok: true, reply: "ok" })))
    );
    expect(enqueueTurn("conv-b", "m0", null)).toBe(true);
    await flush();
    for (let i = 1; i <= 20; i++) expect(enqueueTurn("conv-b", `m${i}`, null)).toBe(true);
    expect(enqueueTurn("conv-b", "m21", null)).toBe(false); // 429 côté HTTP
    release();
    await flush();
  });

  it("un tour qui jette produit un callback ok:false, jamais un silence", async () => {
    runTurn.mockRejectedValueOnce(new Error("kaboom"));
    enqueueTurn("conv-c", "au secours", null);
    await flush();
    expect(sendCallback).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "conv-c", ok: false, error: "turn_failed" })
    );
  });
});
