import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/index.ts";
import { ensureDefaultChannel, defaultSalonName, joinNames } from "../../src/routes/channels.ts";
import { ensureBot } from "../../src/notify.ts";
import { purgeUser } from "../../src/userPurge.ts";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";
import { seedMessage } from "../helpers/seed.js";

// Salons gérés par leurs membres (1.6.0) : tout membre ajoute, retire, renomme,
// décrit et quitte ; seul un admin supprime ou change la visibilité ; un salon
// privé n'existe que pour ses membres, admins compris. Le premier compte
// enregistré dans un test est l'admin bootstrap (la base est vidée avant chaque test).

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

const create = async (token, body) =>
  (await authed(app, token).post("/channels").send(body)).body.channel;

// Textes des messages de service d'un salon, lus comme un membre les voit.
async function systemTexts(token, channelId) {
  const res = await authed(app, token).get(`/channels/${channelId}/messages`);
  return res.body.messages.filter((m) => m.kind === "system").map((m) => m.body);
}

describe("helpers de nommage", () => {
  it("joinNames et defaultSalonName", () => {
    expect(joinNames(["Alice"])).toBe("Alice");
    expect(joinNames(["Alice", "Bob"])).toBe("Alice et Bob");
    expect(joinNames(["Alice", "Bob", "Chloé"])).toBe("Alice, Bob et Chloé");
    expect(defaultSalonName(["Zoé", "alice", "Émile"])).toBe("alice, Émile, Zoé");
    const long = defaultSalonName(Array.from({ length: 20 }, (_, i) => `Personne ${i}`));
    expect(long.length).toBe(80);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("PATCH /channels/:id — tout membre renomme, la visibilité reste aux admins", () => {
  it("un membre renomme et décrit le salon, le salon en garde la trace", async () => {
    const { token: admin } = await registerUser(app);
    const { token: creator } = await registerUser(app);
    const { token: memberTok, user: member } = await registerUser(app);
    const { token: outsider } = await registerUser(app);
    const ch = await create(creator, { name: "equipe", memberIds: [member.id] });

    const ok = await authed(app, memberTok)
      .patch(`/channels/${ch.id}`)
      .send({ name: " equipe-2 ", description: "nouvelle desc" });
    expect(ok.status).toBe(200);
    expect(ok.body.channel).toMatchObject({ name: "equipe-2", description: "nouvelle desc" });
    expect(await systemTexts(creator, ch.id)).toEqual(["a renommé le salon en « equipe-2 »"]);

    // Même nom : rien à tracer.
    await authed(app, memberTok).patch(`/channels/${ch.id}`).send({ name: "equipe-2" });
    expect(await systemTexts(creator, ch.id)).toHaveLength(1);

    // Non membre d'un salon public : refusé ; un admin peut modérer sans en être.
    expect(
      (await authed(app, outsider).patch(`/channels/${ch.id}`).send({ name: "pirate" })).body
    ).toEqual({ error: "not_a_member" });
    const byAdmin = await authed(app, admin).patch(`/channels/${ch.id}`).send({ name: "equipe-3" });
    expect(byAdmin.status).toBe(200);
  });

  it("changer la visibilité : un admin membre seulement", async () => {
    const { token: admin } = await registerUser(app);
    const { token: creator } = await registerUser(app);
    const ch = await create(creator, { name: "ouvert" });

    const refused = await authed(app, creator).patch(`/channels/${ch.id}`).send({ isPrivate: true });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("admin_only");

    // Un admin qui n'en est pas membre le perdrait aussitôt : refusé.
    const outsider = await authed(app, admin).patch(`/channels/${ch.id}`).send({ isPrivate: true });
    expect(outsider.status).toBe(403);
    expect(outsider.body.error).toBe("not_a_member");

    await authed(app, admin).post(`/channels/${ch.id}/join`);
    const madePrivate = await authed(app, admin).patch(`/channels/${ch.id}`).send({ isPrivate: true });
    expect(madePrivate.status).toBe(200);
    expect(madePrivate.body.channel.isPrivate).toBe(true);
    expect(await systemTexts(creator, ch.id)).toEqual([
      "a rejoint le salon",
      "a rendu le salon privé",
    ]);
  });

  it("salon par défaut : modifiable par un admin seulement, jamais privé", async () => {
    const { token: admin } = await registerUser(app);
    const { token: user } = await registerUser(app);
    const def = await ensureDefaultChannel();

    const byUser = await authed(app, user).patch(`/channels/${def.id}`).send({ name: "Accueil" });
    expect(byUser.status).toBe(403);
    expect(byUser.body.error).toBe("admin_only");
    expect(
      (await authed(app, admin).patch(`/channels/${def.id}`).send({ description: "Pour tous" }))
        .status
    ).toBe(200);
    expect(
      (await authed(app, admin).patch(`/channels/${def.id}`).send({ isPrivate: true })).body.error
    ).toBe("cannot_make_default_private");
  });

  it("rejette les DM / Claude, les corps vides et les noms vides", async () => {
    const { token: creator } = await registerUser(app);
    const { user: other } = await registerUser(app);
    const ch = await create(creator, { name: "valide" });
    const dm = (await authed(app, creator).post("/channels/dm").send({ userId: other.id })).body
      .channel;

    expect((await authed(app, creator).patch(`/channels/${dm.id}`).send({ name: "x" })).status).toBe(
      404
    );
    expect((await authed(app, creator).patch(`/channels/${ch.id}`).send({})).status).toBe(400);
    expect(
      (await authed(app, creator).patch(`/channels/${ch.id}`).send({ name: "   " })).status
    ).toBe(400);
  });
});

describe("DELETE /channels/:id — admins seulement", () => {
  it("le créateur ne supprime plus son salon, un admin oui", async () => {
    const { token: admin } = await registerUser(app);
    const { token: creator } = await registerUser(app);
    const ch = await create(creator, { name: "ephemere" });

    const refused = await authed(app, creator).delete(`/channels/${ch.id}`);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("admin_only");

    // Salon public : un admin le supprime sans en être membre.
    expect((await authed(app, admin).delete(`/channels/${ch.id}`)).status).toBe(200);
    expect(await prisma.channel.findUnique({ where: { id: ch.id } })).toBeNull();
  });

  it("un salon privé n'est supprimable que par un admin qui en est membre", async () => {
    const { token: admin, user: adminUser } = await registerUser(app);
    const { token: creator } = await registerUser(app);
    const ch = await create(creator, { name: "secret", isPrivate: true });

    expect((await authed(app, admin).delete(`/channels/${ch.id}`)).status).toBe(404);
    await authed(app, creator).post(`/channels/${ch.id}/members`).send({ userIds: [adminUser.id] });
    expect((await authed(app, admin).delete(`/channels/${ch.id}`)).status).toBe(200);
  });

  it("protège le salon par défaut et les DM", async () => {
    const { token: admin } = await registerUser(app);
    const { user: other } = await registerUser(app);
    const def = await ensureDefaultChannel();
    expect((await authed(app, admin).delete(`/channels/${def.id}`)).body.error).toBe(
      "cannot_delete_default"
    );
    const dm = (await authed(app, admin).post("/channels/dm").send({ userId: other.id })).body
      .channel;
    expect((await authed(app, admin).delete(`/channels/${dm.id}`)).status).toBe(404);
  });
});

describe("membres : ajouter, retirer, quitter, rejoindre", () => {
  it("ajoute des comptes actifs (jamais le bot ni un compte désactivé) et en garde la trace", async () => {
    await registerUser(app); // admin bootstrap
    const { token: creator, user: creatorUser } = await registerUser(app);
    const { user: b } = await registerUser(app, { displayName: "Bérénice" });
    const { user: off } = await registerUser(app);
    await prisma.user.update({ where: { id: off.id }, data: { status: "disabled" } });
    const bot = await ensureBot();
    const ch = await create(creator, { name: "projet", isPrivate: true });

    const res = await authed(app, creator)
      .post(`/channels/${ch.id}/members`)
      .send({ userIds: [b.id, off.id, bot.id, b.id, creatorUser.id, "inconnu", 42] });
    expect(res.status).toBe(200);
    expect(res.body.channel.members.map((m) => m.id).sort()).toEqual(
      [creatorUser.id, b.id].sort()
    );
    expect(await systemTexts(creator, ch.id)).toEqual(["a ajouté Bérénice au salon"]);

    // Déjà membre : personne n'est ajouté, aucune trace de plus.
    await authed(app, creator).post(`/channels/${ch.id}/members`).send({ userIds: [b.id] });
    expect(await systemTexts(creator, ch.id)).toHaveLength(1);
  });

  it("l'annuaire des sélecteurs ne propose ni le bot ni un compte désactivé", async () => {
    const { token } = await registerUser(app);
    const { user: off } = await registerUser(app);
    const { user: on } = await registerUser(app);
    await prisma.user.update({ where: { id: off.id }, data: { status: "disabled" } });
    const bot = await ensureBot();
    const ids = (await authed(app, token).get("/users")).body.users.map((u) => u.id);
    expect(ids).toContain(on.id);
    expect(ids).not.toContain(off.id);
    expect(ids).not.toContain(bot.id);
  });

  it("la création écarte aussi le bot et les comptes désactivés", async () => {
    await registerUser(app);
    const { token: creator } = await registerUser(app);
    const { user: off } = await registerUser(app);
    await prisma.user.update({ where: { id: off.id }, data: { status: "disabled" } });
    const bot = await ensureBot();
    const ch = await create(creator, { name: "neuf", memberIds: [off.id, bot.id, "inconnu"] });
    expect(ch.members).toHaveLength(1);
  });

  it("un membre retire quelqu'un : trace, accès coupé ; se retirer soi-même revient à quitter", async () => {
    await registerUser(app);
    const { token: creator } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app, { displayName: "Bob" });
    const { token: cTok, user: c } = await registerUser(app, { displayName: "Chloé" });
    const ch = await create(creator, { name: "rotation", isPrivate: true, memberIds: [b.id, c.id] });

    // Un simple membre (pas le créateur) retire quelqu'un.
    expect((await authed(app, bTok).delete(`/channels/${ch.id}/members/${c.id}`)).status).toBe(200);
    expect((await authed(app, cTok).get(`/channels/${ch.id}/messages`)).status).toBe(403);
    // Plus membre : 404, aucune trace en double.
    expect((await authed(app, bTok).delete(`/channels/${ch.id}/members/${c.id}`)).status).toBe(404);

    expect((await authed(app, bTok).delete(`/channels/${ch.id}/members/${b.id}`)).status).toBe(200);
    expect(await systemTexts(creator, ch.id)).toEqual([
      "a retiré Chloé du salon",
      "a quitté le salon",
    ]);
  });

  it("le dernier membre qui quitte un salon privé le supprime ; un salon public reste", async () => {
    await registerUser(app);
    const { token: creator } = await registerUser(app);
    const priv = await create(creator, { name: "seul", isPrivate: true });
    await seedMessage({ channelId: priv.id, authorId: priv.members[0].id, body: "trace" });
    const pub = await create(creator, { name: "ouvert" });

    expect((await authed(app, creator).post(`/channels/${priv.id}/leave`)).status).toBe(200);
    expect(await prisma.channel.findUnique({ where: { id: priv.id } })).toBeNull();
    expect(await prisma.message.count({ where: { channelId: priv.id } })).toBe(0);

    expect((await authed(app, creator).post(`/channels/${pub.id}/leave`)).status).toBe(200);
    expect(await prisma.channel.findUnique({ where: { id: pub.id } })).not.toBeNull();
    // Personne pour lire un « a quitté le salon » : rien n'est posté.
    expect(await prisma.message.count({ where: { channelId: pub.id } })).toBe(0);
  });

  it("un salon privé où ne reste que le bot est supprimé au départ du dernier membre", async () => {
    await registerUser(app);
    const { token: creator } = await registerUser(app);
    const ch = await create(creator, { name: "avec-bot", isPrivate: true });
    // Un ancien groupe pouvait inclure le bot (il était proposé avant la 1.6.0).
    const bot = await ensureBot();
    await prisma.membership.create({ data: { userId: bot.id, channelId: ch.id } });

    expect((await authed(app, creator).post(`/channels/${ch.id}/leave`)).status).toBe(200);
    expect(await prisma.channel.findUnique({ where: { id: ch.id } })).toBeNull();
  });

  it("le salon du pipeline (support-dev) garde son historique au départ de son dernier membre", async () => {
    const { token: admin, user: adminUser } = await registerUser(app);
    const support = await prisma.channel.create({
      data: {
        name: "support-dev",
        isPrivate: true,
        memberships: { create: [{ userId: adminUser.id }] },
      },
    });
    await seedMessage({ channelId: support.id, authorId: adminUser.id, body: "PR ouverte" });
    expect((await authed(app, admin).post(`/channels/${support.id}/leave`)).status).toBe(200);
    expect(await prisma.channel.findUnique({ where: { id: support.id } })).not.toBeNull();
    expect(await prisma.message.count({ where: { channelId: support.id } })).toBe(1);
  });

  it("quitter : salon par défaut protégé, DM 404, salon privé d'autrui 404", async () => {
    const { token: admin } = await registerUser(app);
    const { token: other, user: otherUser } = await registerUser(app);
    const def = await ensureDefaultChannel();
    expect((await authed(app, admin).post(`/channels/${def.id}/leave`)).status).toBe(403);
    expect(
      (await authed(app, admin).delete(`/channels/${def.id}/members/${otherUser.id}`)).status
    ).toBe(403);
    const dm = (await authed(app, admin).post("/channels/dm").send({ userId: otherUser.id })).body
      .channel;
    expect((await authed(app, admin).post(`/channels/${dm.id}/leave`)).status).toBe(404);
    const priv = await create(other, { name: "a-moi", isPrivate: true });
    expect((await authed(app, admin).post(`/channels/${priv.id}/leave`)).status).toBe(404);
  });

  it("rejoindre un salon public laisse une trace, une seule fois", async () => {
    await registerUser(app);
    const { token: creator } = await registerUser(app);
    const { token: bTok } = await registerUser(app);
    const pub = await create(creator, { name: "libre" });
    await authed(app, bTok).post(`/channels/${pub.id}/join`);
    await authed(app, bTok).post(`/channels/${pub.id}/join`);
    expect(await systemTexts(creator, pub.id)).toEqual(["a rejoint le salon"]);
  });
});

describe("messages de service", () => {
  it("ne rendent pas le salon non lu, ne remontent ni en aperçu ni dans la recherche", async () => {
    await registerUser(app);
    const { token: creator, user: creatorUser } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app);
    const ch = await create(creator, { name: "calme", memberIds: [b.id] });
    await seedMessage({ channelId: ch.id, authorId: creatorUser.id, body: "bonjour" });
    await prisma.membership.update({
      where: { userId_channelId: { userId: b.id, channelId: ch.id } },
      data: { lastReadAt: new Date() },
    });

    await authed(app, creator).patch(`/channels/${ch.id}`).send({ name: "renomme-xylophone" });

    const listed = (await authed(app, bTok).get("/channels")).body.channels.find(
      (c) => c.id === ch.id
    );
    expect(listed.unread).toBe(false);
    expect(listed.lastMessage.body).toBe("bonjour");

    const page = (await authed(app, bTok).get(`/channels/${ch.id}/messages`)).body;
    expect(page.firstUnreadId).toBeNull();
    expect(page.messages.map((m) => m.kind)).toEqual(["user", "system"]);

    const search = await authed(app, bTok).get("/search?q=xylophone");
    expect(search.body.results).toHaveLength(0);
  });

  it("ne se modifient, ne se suppriment ni ne reçoivent de réaction", async () => {
    await registerUser(app);
    const { token: creator } = await registerUser(app);
    const ch = await create(creator, { name: "fige" });
    await authed(app, creator).patch(`/channels/${ch.id}`).send({ name: "fige-2" });
    const sys = (await authed(app, creator).get(`/channels/${ch.id}/messages`)).body.messages.find(
      (m) => m.kind === "system"
    );

    const asCreator = authed(app, creator);
    expect((await asCreator.patch(`/channels/messages/${sys.id}`).send({ body: "x" })).status).toBe(
      404
    );
    expect((await asCreator.delete(`/channels/messages/${sys.id}`)).status).toBe(404);
    expect(
      (await asCreator.post(`/channels/messages/${sys.id}/reactions`).send({ emoji: "👍" })).status
    ).toBe(404);
  });
});

describe("POST /channels/dm à plusieurs (clients antérieurs à la 1.6.0)", () => {
  it("crée un salon privé nommé d'après ses membres, puis le rouvre", async () => {
    const { token: a } = await registerUser(app, { displayName: "Zoé" });
    const { user: b } = await registerUser(app, { displayName: "Alice" });
    const { user: c } = await registerUser(app, { displayName: "Marc" });

    const first = await authed(app, a).post("/channels/dm").send({ userIds: [b.id, c.id] });
    expect(first.status).toBe(200);
    expect(first.body.channel).toMatchObject({
      isDirect: false,
      isPrivate: true,
      name: "Alice, Marc, Zoé",
    });
    expect(first.body.channel.members).toHaveLength(3);

    const again = await authed(app, a).post("/channels/dm").send({ userIds: [c.id, b.id] });
    expect(again.body.channel.id).toBe(first.body.channel.id);
  });

  it("refuse un compte désactivé", async () => {
    const { token: a } = await registerUser(app);
    const { user: b } = await registerUser(app);
    const { user: off } = await registerUser(app);
    await prisma.user.update({ where: { id: off.id }, data: { status: "disabled" } });
    const res = await authed(app, a).post("/channels/dm").send({ userIds: [b.id, off.id] });
    expect(res.status).toBe(400);
  });
});

describe("masquer une conversation directe", () => {
  it("la masque pour soi seul ; la rouvrir la fait réapparaître", async () => {
    const { token: a } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app);
    const dm = (await authed(app, a).post("/channels/dm").send({ userId: b.id })).body.channel;
    expect(dm.hiddenAt).toBeNull();
    // Un message non lu de b : masquer la conversation la marque lue (sinon un
    // non-lu invisible resterait dans le badge de l'app).
    await seedMessage({ channelId: dm.id, authorId: b.id, body: "coucou" });
    expect(
      (await authed(app, a).get("/channels")).body.channels.find((c) => c.id === dm.id).unread
    ).toBe(true);

    const hidden = await authed(app, a).post(`/channels/${dm.id}/hide`);
    expect(hidden.status).toBe(200);
    const find = async (token) =>
      (await authed(app, token).get("/channels")).body.channels.find((c) => c.id === dm.id);
    expect((await find(a)).hiddenAt).toBeTruthy();
    expect((await find(a)).unread).toBe(false);
    expect((await find(bTok)).hiddenAt).toBeNull();

    const reopened = await authed(app, a).post("/channels/dm").send({ userId: b.id });
    expect(reopened.body.channel.id).toBe(dm.id);
    expect(reopened.body.channel.hiddenAt).toBeNull();
    expect((await find(a)).hiddenAt).toBeNull();
  });

  it("refuse un salon (on le quitte) et une conversation dont on n'est pas membre", async () => {
    const { token: a } = await registerUser(app);
    const { user: b } = await registerUser(app);
    const { token: cTok } = await registerUser(app);
    const ch = await create(a, { name: "salon" });
    expect((await authed(app, a).post(`/channels/${ch.id}/hide`)).status).toBe(404);
    const dm = (await authed(app, a).post("/channels/dm").send({ userId: b.id })).body.channel;
    expect((await authed(app, cTok).post(`/channels/${dm.id}/hide`)).status).toBe(404);
  });
});

describe("purge d'un compte", () => {
  it("un salon privé dont il était le seul membre disparaît avec lui", async () => {
    const { user: admin } = await registerUser(app);
    const { token: victimTok, user: victim } = await registerUser(app);
    const { user: b } = await registerUser(app);
    const alone = await create(victimTok, { name: "solo", isPrivate: true });
    const shared = await create(victimTok, { name: "duo", isPrivate: true, memberIds: [b.id] });

    await purgeUser(io, victim.id, admin.id);
    expect(await prisma.channel.findUnique({ where: { id: alone.id } })).toBeNull();
    expect(await prisma.channel.findUnique({ where: { id: shared.id } })).not.toBeNull();
  });
});
