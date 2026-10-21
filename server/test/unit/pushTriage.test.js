import { describe, it, expect } from "vitest";
import { triagePush } from "../../../shared/pushTriage.ts";

const unread = (receivedAt = 0) => ({ read: false, receivedAt });
const read = (receivedAt = 0) => ({ read: true, receivedAt });
const unknown = (receivedAt = 0) => ({ read: null, receivedAt });

describe("triagePush (tri d'un Web Push à son arrivée)", () => {
  it("message non lu : affiché normalement, les notifications lues depuis sont fermées", () => {
    expect(triagePush(false, [read(1), unread(2), read(3)])).toEqual({
      show: "normal",
      close: [0, 2],
    });
  });

  it("état inconnu (serveur injoignable) : comportement d'avant, rien n'est fermé", () => {
    expect(triagePush(null, [unknown(1), unknown(2)])).toEqual({ show: "normal", close: [] });
  });

  it("message déjà lu alors qu'une notification non lue reste : rien d'affiché", () => {
    expect(triagePush(true, [read(1), unread(2)])).toEqual({ show: "none", close: [0] });
  });

  it("une notification d'état inconnu suffit à rester visible : rien d'affiché", () => {
    expect(triagePush(true, [unknown(1)])).toEqual({ show: "none", close: [] });
  });

  it("message déjà lu et seules des notifications lues : on garde la plus récente", () => {
    expect(triagePush(true, [read(5), read(9), read(2)])).toEqual({
      show: "none",
      close: [0, 2],
    });
  });

  it("message déjà lu et rien d'affiché : montré, mais en silence", () => {
    expect(triagePush(true, [])).toEqual({ show: "silent", close: [] });
  });

  it("Safari/iOS : un push affiche toujours quelque chose, en silence s'il est lu", () => {
    expect(triagePush(true, [read(1), unread(2)], true)).toEqual({ show: "silent", close: [0] });
    expect(triagePush(false, [read(1)], true)).toEqual({ show: "normal", close: [0] });
  });

  it("ne laisse jamais zéro notification visible sans en afficher une", () => {
    // Invariant « un push laisse une notification visible » (Chrome / Safari),
    // vérifié sur toutes les combinaisons de 0 à 3 notifications affichées.
    const states = [true, false, null];
    const combos = [[]];
    for (let n = 0; n < 3; n++) {
      for (const c of [...combos]) for (const s of states) combos.push([...c, s]);
    }
    for (const incoming of states) {
      for (const combo of combos) {
        const displayed = combo.map((s, i) => ({ read: s, receivedAt: i }));
        for (const mustShow of [false, true]) {
          const { show, close } = triagePush(incoming, displayed, mustShow);
          const remaining = displayed.length - close.length;
          expect(show !== "none" || remaining > 0).toBe(true);
        }
      }
    }
  });
});
