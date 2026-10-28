import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import { checkDiskSpace } from "../../src/diskAlert.ts";
import { prisma } from "../helpers/db.js";

// Disque simulé de 100 Go (blocs de 4 Kio) occupé à `usedPct` %.
function diskAt(usedPct) {
  const blocks = 100 * 2 ** 18;
  const bavail = Math.round(blocks * (1 - usedPct / 100));
  vi.spyOn(fs.promises, "statfs").mockResolvedValue({ bsize: 4096, blocks, bavail });
}

afterEach(() => vi.restoreAllMocks());

describe("checkDiskSpace", () => {
  it("avertit support-dev une fois par palier franchi et ne se réarme que nettement en dessous", async () => {
    // Un seul scénario : le palier déjà signalé vit en mémoire du module.
    for (const [pct, level] of [
      [50, 0],
      [91.5, 90], // alerte 90 %
      [92.5, 90], // déjà signalé
      [96.5, 95], // alerte 95 %
      [94.5, 90], // redescendu, mais pas 2 points sous 95 : rien
      [85.5, 0], // réarmé
      [91.5, 90], // nouvelle alerte 90 %
    ]) {
      diskAt(pct);
      expect(await checkDiskSpace()).toBe(level);
    }

    const alerts = await prisma.message.findMany({
      where: { channel: { name: "support-dev", isPrivate: true } },
      orderBy: { createdAt: "asc" },
      select: { searchableBody: true, author: { select: { username: true } } },
    });
    expect(alerts.map((m) => m.author.username)).toEqual(["claude", "claude", "claude"]);
    expect(alerts[0].searchableBody).toContain("occupé à 91 % : il reste 8,5 Go sur 100,0 Go");
    expect(alerts[1].searchableBody).toContain("occupé à 96 %");
    expect(alerts[2].searchableBody).toContain("occupé à 91 %");
  });
});
