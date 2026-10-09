import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/index.ts";
import { registerUser, authed } from "../helpers/api.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

describe("PATCH /channels/:id (renommer / modifier son salon)", () => {
  it("le créateur renomme son salon, un tiers est refusé, l'admin passe", async () => {
    const { token: admin } = await registerUser(app);
    const { token: creator } = await registerUser(app);
    const { token: outsider } = await registerUser(app);
    const ch = (
      await authed(app, creator).post("/channels").send({ name: "equipe" })
    ).body.channel;
    expect(ch.createdById).toBeTruthy();

    // Tiers non membre : 403 (membre ou propriétaire requis).
    expect(
      (await authed(app, outsider).patch(`/channels/${ch.id}`).send({ name: "pirate" }))
        .status
    ).toBe(403);

    // Créateur : ok.
    const ok = await authed(app, creator)
      .patch(`/channels/${ch.id}`)
      .send({ name: "equipe-2", description: "nouvelle desc" });
    expect(ok.status).toBe(200);
    expect(ok.body.channel).toMatchObject({ name: "equipe-2", description: "nouvelle desc" });

    // Admin même non membre : ok.
    const byAdmin = await authed(app, admin)
      .patch(`/channels/${ch.id}`)
      .send({ name: "equipe-3" });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.channel.name).toBe("equipe-3");
  });

  it("rejette les DM / Claude, les corps vides et les noms vides", async () => {
    const { token: creator } = await registerUser(app);
    const { user: other } = await registerUser(app);
    const ch = (
      await authed(app, creator).post("/channels").send({ name: "valide" })
    ).body.channel;
    const dm = (
      await authed(app, creator).post("/channels/dm").send({ userId: other.id })
    ).body.channel;

    expect((await authed(app, creator).patch(`/channels/${dm.id}`).send({ name: "x" })).status).toBe(
      404
    );
    expect((await authed(app, creator).patch(`/channels/${ch.id}`).send({})).status).toBe(400);
    expect(
      (await authed(app, creator).patch(`/channels/${ch.id}`).send({ name: "" })).status
    ).toBe(400);
  });
});

describe("DELETE /channels/:id (supprimer son salon)", () => {
  it("le créateur supprime, un tiers est refusé, le salon disparaît", async () => {
    const { token: creator } = await registerUser(app);
    const { token: outsider } = await registerUser(app);
    const ch = (
      await authed(app, creator).post("/channels").send({ name: "ephemere" })
    ).body.channel;

    expect((await authed(app, outsider).delete(`/channels/${ch.id}`)).status).toBe(403);
    const del = await authed(app, creator).delete(`/channels/${ch.id}`);
    expect(del.status).toBe(200);
    const list = await authed(app, creator).get("/channels");
    expect(list.body.channels.some((c) => c.id === ch.id)).toBe(false);
  });

  it("protège le salon par défaut et les DM", async () => {
    const { token: creator } = await registerUser(app);
    const { user: other } = await registerUser(app);
    const list = await authed(app, creator).get("/channels");
    const def = list.body.channels.find((c) => c.isDefault);
    if (def) {
      // Le créateur historique est null : seul l'admin passe la garde
      // propriétaire, mais la suppression reste interdite dans tous les cas.
      expect((await authed(app, creator).delete(`/channels/${def.id}`)).status).toBe(403);
    }
    const dm = (
      await authed(app, creator).post("/channels/dm").send({ userId: other.id })
    ).body.channel;
    expect((await authed(app, creator).delete(`/channels/${dm.id}`)).status).toBe(404);
  });
});
