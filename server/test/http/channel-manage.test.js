import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/index.ts";
import {
  ensureDefaultChannel,
  ensureSalonAdmins,
  defaultSalonName,
  joinNames,
} from "../../src/routes/channels.ts";
import { ensureBot } from "../../src/notify.ts";
import { purgeUser } from "../../src/userPurge.ts";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";
import { seedMessage } from "../helpers/seed.js";

// Salons gérés par leurs membres (1.6.0) : tout membre ajoute, retire un simple
// membre, renomme, décrit et quitte ; les admins du salon (son créateur, puis
// ceux qu'il nomme) et les admins du chat suppriment, changent la visibilité,
// nomment et retirent les admins du salon ; un salon privé n'existe que pour ses
// membres, admins du chat compris. Le premier compte enregistré dans un test est
// l'admin bootstrap du chat (la base est vidée avant chaque test) : les cas
// « simple membre » et « admin du salon » utilisent les comptes suivants.

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
  return (await systemLog(token, channelId)).map((m) => m.body);
}

// Les mêmes, avec leur auteur (le membre qui a fait l'action — ou celui qui est
// devenu admin, pour une promotion automatique).
async function systemLog(token, channelId) {
  const res = await authed(app, token).get(`/channels/${channelId}/messages`);
  return res.body.messages
    .filter((m) => m.kind === "system")
    .map((m) => ({ body: m.body, authorId: m.author.id }));
}

const setRole = (token, channelId, userId, role) =>
  authed(app, token).patch(`/channels/${channelId}/members/${userId}`).send({ role });

// `adminIds` du salon tel que le voit `token` dans sa liste.
async function adminIdsSeenBy(token, channelId) {
  const list = (await authed(app, token).get("/channels")).body.channels;
  return list.find((c) => c.id === channelId).adminIds;
}

// Admins du salon d'après la base, triés.
async function adminsOf(channelId) {
  const rows = await prisma.membership.findMany({ where: { channelId, role: "admin" } });
  return rows.map((m) => m.userId).sort();
}

// L'ancienneté décide du successeur d'un admin parti : fixée explicitement, les
// membres créés ensemble partageant le même horodatage.
const setJoinedAt = (userId, channelId, iso) =>
  prisma.membership.update({
    where: { userId_channelId: { userId, channelId } },
    data: { joinedAt: new Date(iso) },
  });

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

describe("PATCH /channels/:id — tout membre renomme, la visibilité revient aux admins", () => {
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

  it("changer la visibilité : l'admin du salon oui, un simple membre non", async () => {
    await registerUser(app); // admin du chat
    const { token: creator } = await registerUser(app);
    const { token: memberTok, user: member } = await registerUser(app);
    const ch = await create(creator, { name: "ouvert", memberIds: [member.id] });

    const refused = await authed(app, memberTok).patch(`/channels/${ch.id}`).send({ isPrivate: true });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("admin_only");

    // Le créateur est l'admin du salon : il le rend privé, puis public.
    const madePrivate = await authed(app, creator).patch(`/channels/${ch.id}`).send({ isPrivate: true });
    expect(madePrivate.status).toBe(200);
    expect(madePrivate.body.channel.isPrivate).toBe(true);
    expect(
      (await authed(app, memberTok).patch(`/channels/${ch.id}`).send({ isPrivate: false })).body
        .error
    ).toBe("admin_only");
    expect(
      (await authed(app, creator).patch(`/channels/${ch.id}`).send({ isPrivate: false })).status
    ).toBe(200);
    expect(await systemTexts(creator, ch.id)).toEqual([
      "a rendu le salon privé",
      "a rendu le salon public",
    ]);
  });

  it("un admin du chat change la visibilité en membre, jamais en aveugle", async () => {
    const { token: admin } = await registerUser(app);
    const { token: creator } = await registerUser(app);
    const ch = await create(creator, { name: "ouvert" });

    // Un admin qui n'en est pas membre le perdrait aussitôt : refusé.
    const outsider = await authed(app, admin).patch(`/channels/${ch.id}`).send({ isPrivate: true });
    expect(outsider.status).toBe(403);
    expect(outsider.body.error).toBe("not_a_member");

    // Simple membre du salon, mais admin du chat : il garde ce droit.
    await authed(app, admin).post(`/channels/${ch.id}/join`);
    const madePrivate = await authed(app, admin).patch(`/channels/${ch.id}`).send({ isPrivate: true });
    expect(madePrivate.status).toBe(200);
    expect(madePrivate.body.channel.isPrivate).toBe(true);
    expect(madePrivate.body.channel.adminIds).toHaveLength(1);
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

describe("DELETE /channels/:id — l'admin du salon ou un admin du chat", () => {
  it("l'admin du salon le supprime ; ni un simple membre ni un non-membre", async () => {
    await registerUser(app); // admin du chat
    const { token: creator } = await registerUser(app);
    const { token: memberTok, user: member } = await registerUser(app);
    const { token: outsider } = await registerUser(app);
    const ch = await create(creator, { name: "ephemere", memberIds: [member.id] });

    const byMember = await authed(app, memberTok).delete(`/channels/${ch.id}`);
    expect(byMember.status).toBe(403);
    expect(byMember.body.error).toBe("admin_only");
    const byOutsider = await authed(app, outsider).delete(`/channels/${ch.id}`);
    expect(byOutsider.status).toBe(403);
    expect(byOutsider.body.error).toBe("not_a_member");

    expect((await authed(app, creator).delete(`/channels/${ch.id}`)).status).toBe(200);
    expect(await prisma.channel.findUnique({ where: { id: ch.id } })).toBeNull();
  });

  it("un admin du chat supprime un salon public sans en être membre", async () => {
    const { token: admin } = await registerUser(app);
    const { token: creator } = await registerUser(app);
    const ch = await create(creator, { name: "ephemere" });

    expect((await authed(app, admin).delete(`/channels/${ch.id}`)).status).toBe(200);
    expect(await prisma.channel.findUnique({ where: { id: ch.id } })).toBeNull();
  });

  it("un salon privé n'est supprimable par un admin du chat que s'il en est membre", async () => {
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

  it("purger le dernier admin d'un salon : le plus ancien membre restant le devient", async () => {
    const { user: admin } = await registerUser(app);
    const { token: victimTok, user: victim } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app);
    const { user: c } = await registerUser(app);
    const shared = await create(victimTok, {
      name: "relais",
      isPrivate: true,
      memberIds: [b.id, c.id],
    });
    // Un salon où il n'était que membre ne bouge pas.
    const other = await create(bTok, { name: "autre", memberIds: [victim.id] });
    await setJoinedAt(c.id, shared.id, "2026-01-01");
    await setJoinedAt(b.id, shared.id, "2026-01-02");

    await purgeUser(io, victim.id, admin.id);
    expect(await adminsOf(shared.id)).toEqual([c.id]);
    expect(await systemLog(bTok, shared.id)).toEqual([
      { body: "est maintenant admin du salon", authorId: c.id },
    ]);
    expect(await adminsOf(other.id)).toEqual([b.id]);
    expect(await systemTexts(bTok, other.id)).toEqual([]);
  });
});

describe("admins du salon : le créateur, et `adminIds` partout", () => {
  it("le créateur d'un salon en est l'admin ; les personnes ajoutées, de simples membres", async () => {
    await registerUser(app); // admin du chat
    const { token: creator, user: creatorUser } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app);
    const { token: cTok, user: c } = await registerUser(app);
    const { token: outsider } = await registerUser(app);
    const ch = await create(creator, { name: "neuf", memberIds: [b.id] });
    expect(ch.adminIds).toEqual([creatorUser.id]);

    const added = await authed(app, bTok).post(`/channels/${ch.id}/members`).send({ userIds: [c.id] });
    expect(added.body.channel.adminIds).toEqual([creatorUser.id]);
    expect(await adminIdsSeenBy(cTok, ch.id)).toEqual([creatorUser.id]);
    expect(await adminsOf(ch.id)).toEqual([creatorUser.id]);
    // Le salon tel qu'un non-membre le découvre (« Parcourir les salons »).
    const listed = (await authed(app, outsider).get("/channels/public")).body.channels;
    expect(listed.find((x) => x.id === ch.id).adminIds).toEqual([creatorUser.id]);
  });

  it("POST /channels/dm à plusieurs : celui qui crée le salon en est l'admin", async () => {
    await registerUser(app);
    const { token: a, user: aUser } = await registerUser(app);
    const { user: b } = await registerUser(app);
    const { user: c } = await registerUser(app);
    const res = await authed(app, a).post("/channels/dm").send({ userIds: [b.id, c.id] });
    expect(res.status).toBe(200);
    expect(res.body.channel.adminIds).toEqual([aUser.id]);
    expect(await adminsOf(res.body.channel.id)).toEqual([aUser.id]);
  });

  it("aucun admin du salon ailleurs : DM, Mes notes, Général, expert Claude, salon du pipeline", async () => {
    const { token: admin, user: adminUser } = await registerUser(app);
    const { user: b } = await registerUser(app);
    const def = await ensureDefaultChannel();
    const dm = (await authed(app, admin).post("/channels/dm").send({ userId: b.id })).body.channel;
    const notes = (await authed(app, admin).post("/channels/dm").send({ userIds: [] })).body.channel;
    expect(dm.adminIds).toEqual([]);
    expect(notes.adminIds).toEqual([]);
    // Le salon du pipeline, tel que notify.ts le crée (son nom lui est réservé).
    const support = await prisma.channel.create({
      data: {
        name: "support-dev",
        isPrivate: true,
        memberships: { create: [{ userId: adminUser.id }] },
      },
    });
    // Même une colonne incohérente n'y fait pas apparaître d'admin.
    const bot = await ensureBot();
    const expert = await prisma.channel.create({
      data: {
        kind: "claude",
        isPrivate: true,
        name: "Expert",
        memberships: { create: [{ userId: adminUser.id, role: "admin" }, { userId: bot.id }] },
      },
    });
    await prisma.membership.updateMany({
      where: { channelId: { in: [def.id, dm.id, support.id] } },
      data: { role: "admin" },
    });

    const list = (await authed(app, admin).get("/channels")).body.channels;
    for (const id of [def.id, dm.id, notes.id, expert.id, support.id]) {
      expect(list.find((c) => c.id === id).adminIds).toEqual([]);
    }
  });
});

// Le salon du pipeline se reconnaît à son seul nom (notify.ts), et il n'a pas
// d'admins du salon : un salon qui le prendrait perdrait les siens.
describe("nom réservé au salon du pipeline", () => {
  it("un simple membre ne renomme pas le salon en « support-dev » pour en évincer l'admin", async () => {
    const { token: chatAdmin } = await registerUser(app);
    const { token: aliceTok, user: alice } = await registerUser(app);
    const { token: bobTok, user: bob } = await registerUser(app);
    const { user: carol } = await registerUser(app);
    const ch = await create(aliceTok, {
      name: "secret",
      isPrivate: true,
      memberIds: [bob.id, carol.id],
    });

    const renamed = await authed(app, bobTok).patch(`/channels/${ch.id}`).send({ name: "support-dev" });
    expect(renamed.status).toBe(409);
    expect(renamed.body.error).toBe("reserved_name");
    expect((await prisma.channel.findUnique({ where: { id: ch.id } })).name).toBe("secret");
    // Toujours un salon géré : son admin reste hors d'atteinte d'un simple membre.
    const evicted = await authed(app, bobTok).delete(`/channels/${ch.id}/members/${alice.id}`);
    expect(evicted.status).toBe(403);
    expect(evicted.body.error).toBe("admin_only");
    expect(await adminsOf(ch.id)).toEqual([alice.id]);
    expect(await systemTexts(aliceTok, ch.id)).toEqual([]);

    // Ni l'admin du salon, ni un admin du chat (« Général » compris, que le
    // pipeline adopterait en retirant tous ses membres non admins).
    expect(
      (await authed(app, aliceTok).patch(`/channels/${ch.id}`).send({ name: "support-dev" })).status
    ).toBe(409);
    const def = await ensureDefaultChannel();
    const general = await authed(app, chatAdmin).patch(`/channels/${def.id}`).send({ name: "support-dev" });
    expect(general.status).toBe(409);
    expect(general.body.error).toBe("reserved_name");
  });

  it("on ne crée pas de salon sous ce nom ; le salon du pipeline garde le sien", async () => {
    const { token: admin, user: adminUser } = await registerUser(app);
    const { user: b } = await registerUser(app);
    const created = await authed(app, admin)
      .post("/channels")
      .send({ name: " support-dev ", isPrivate: true, memberIds: [b.id] });
    expect(created.status).toBe(409);
    expect(created.body.error).toBe("reserved_name");
    expect(await prisma.channel.count({ where: { name: "support-dev" } })).toBe(0);

    // Renommé, le salon du pipeline cesserait de l'être : un salon géré, ses
    // membres et aucun admin. Sa description, elle, se modifie.
    const support = await prisma.channel.create({
      data: {
        name: "support-dev",
        isPrivate: true,
        memberships: { create: [{ userId: adminUser.id }] },
      },
    });
    const away = await authed(app, admin).patch(`/channels/${support.id}`).send({ name: "pipeline" });
    expect(away.status).toBe(409);
    expect(away.body.error).toBe("reserved_name");
    const described = await authed(app, admin)
      .patch(`/channels/${support.id}`)
      .send({ name: "support-dev", description: "Les PR du pipeline" });
    expect(described.status).toBe(200);
    expect(described.body.channel).toMatchObject({ name: "support-dev", adminIds: [] });
    expect(await adminsOf(support.id)).toEqual([]);
  });
});

describe("PATCH /channels/:id/members/:userId — nommer et retirer les admins du salon", () => {
  it("l'admin du salon nomme un membre admin : trace, droits d'admin ; déjà admin, rien", async () => {
    await registerUser(app);
    const { token: creator, user: creatorUser } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app, { displayName: "Bob" });
    const ch = await create(creator, { name: "equipe", memberIds: [b.id] });

    const res = await setRole(creator, ch.id, b.id, "admin");
    expect(res.status).toBe(200);
    expect(res.body.channel.adminIds.sort()).toEqual([creatorUser.id, b.id].sort());
    expect(await adminsOf(ch.id)).toEqual([creatorUser.id, b.id].sort());
    expect(await systemLog(bTok, ch.id)).toEqual([
      { body: "a nommé Bob admin du salon", authorId: creatorUser.id },
    ]);

    // Déjà admin : 200, ni diffusion ni trace.
    const again = await setRole(creator, ch.id, b.id, "admin");
    expect(again.status).toBe(200);
    expect(again.body.channel.adminIds).toHaveLength(2);
    expect(await systemTexts(bTok, ch.id)).toHaveLength(1);

    // Les droits suivent le rôle : Bob supprime le salon.
    expect((await authed(app, bTok).delete(`/channels/${ch.id}`)).status).toBe(200);
  });

  it("refuse un simple membre, un non-membre, une cible absente et un corps invalide", async () => {
    const { token: chatAdmin } = await registerUser(app);
    const { token: creator, user: creatorUser } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app);
    const { token: outsider, user: o } = await registerUser(app);
    const pub = await create(creator, { name: "ouvert", memberIds: [b.id] });
    const priv = await create(creator, { name: "ferme", isPrivate: true, memberIds: [b.id] });

    const byMember = await setRole(bTok, pub.id, b.id, "admin");
    expect(byMember.status).toBe(403);
    expect(byMember.body.error).toBe("admin_only");
    const byOutsider = await setRole(outsider, pub.id, o.id, "admin");
    expect(byOutsider.status).toBe(403);
    expect(byOutsider.body.error).toBe("not_a_member");
    // Un salon privé n'existe pas pour un non-membre.
    const hidden = await setRole(outsider, priv.id, b.id, "admin");
    expect(hidden.status).toBe(404);
    expect(hidden.body.error).toBe("not_found");
    // Admins du chat compris : ils ne nomment personne dans un salon privé dont
    // ils ne sont pas membres.
    const byChatAdmin = await setRole(chatAdmin, priv.id, b.id, "admin");
    expect(byChatAdmin.status).toBe(404);
    expect(byChatAdmin.body.error).toBe("not_found");
    expect(await adminsOf(priv.id)).toEqual([creatorUser.id]);
    expect(await systemTexts(creator, priv.id)).toEqual([]);
    const absent = await setRole(creator, pub.id, o.id, "admin");
    expect(absent.status).toBe(404);
    expect(absent.body.error).toBe("not_a_member");
    for (const body of [{}, { role: "owner" }, { role: true }]) {
      const bad = await authed(app, creator).patch(`/channels/${pub.id}/members/${b.id}`).send(body);
      expect(bad.status).toBe(400);
    }

    expect(await adminsOf(pub.id)).toEqual([creatorUser.id]);
    expect(await systemTexts(creator, pub.id)).toEqual([]);
  });

  it("pas de rôles hors des salons gérés : Général, salon du pipeline, DM", async () => {
    const { token: admin, user: adminUser } = await registerUser(app);
    const { user: b } = await registerUser(app);
    const def = await ensureDefaultChannel();
    const general = await setRole(admin, def.id, b.id, "admin");
    expect(general.status).toBe(403);
    expect(general.body.error).toBe("no_roles");

    const support = await prisma.channel.create({
      data: {
        name: "support-dev",
        isPrivate: true,
        memberships: { create: [{ userId: adminUser.id }] },
      },
    });
    const pipeline = await setRole(admin, support.id, adminUser.id, "admin");
    expect(pipeline.status).toBe(403);
    expect(pipeline.body.error).toBe("no_roles");

    const dm = (await authed(app, admin).post("/channels/dm").send({ userId: b.id })).body.channel;
    expect((await setRole(admin, dm.id, b.id, "admin")).status).toBe(404);
    expect(await prisma.membership.count({ where: { role: "admin" } })).toBe(0);
  });

  it("le dernier admin ne peut pas se retirer le rôle ; s'il y en a un autre, si", async () => {
    const { token: chatAdmin } = await registerUser(app);
    const { token: creator, user: creatorUser } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app, { displayName: "Bob" });
    const ch = await create(creator, { name: "relais", memberIds: [b.id] });

    const alone = await setRole(creator, ch.id, creatorUser.id, "member");
    expect(alone.status).toBe(409);
    expect(alone.body.error).toBe("last_admin");
    // Un admin du chat ne laisse pas non plus le salon sans admin.
    const byChatAdmin = await setRole(chatAdmin, ch.id, creatorUser.id, "member");
    expect(byChatAdmin.status).toBe(409);
    expect(byChatAdmin.body.error).toBe("last_admin");

    await setRole(creator, ch.id, b.id, "admin");
    const stepDown = await setRole(creator, ch.id, creatorUser.id, "member");
    expect(stepDown.status).toBe(200);
    expect(stepDown.body.channel.adminIds).toEqual([b.id]);
    // Bob est désormais le dernier.
    expect((await setRole(bTok, ch.id, b.id, "member")).body.error).toBe("last_admin");
    expect(await systemLog(bTok, ch.id)).toEqual([
      { body: "a nommé Bob admin du salon", authorId: creatorUser.id },
      { body: "n'est plus admin du salon", authorId: creatorUser.id },
    ]);
    // Redevenu simple membre, il n'administre plus rien.
    expect((await authed(app, creator).delete(`/channels/${ch.id}`)).body.error).toBe("admin_only");
  });

  it("retirer le rôle d'admin à un autre ; déjà simple membre, rien", async () => {
    await registerUser(app);
    const { token: creator, user: creatorUser } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app, { displayName: "Bob" });
    const ch = await create(creator, { name: "tour", memberIds: [b.id] });
    await setRole(creator, ch.id, b.id, "admin");

    const demoted = await setRole(creator, ch.id, b.id, "member");
    expect(demoted.status).toBe(200);
    expect(demoted.body.channel.adminIds).toEqual([creatorUser.id]);
    const again = await setRole(creator, ch.id, b.id, "member");
    expect(again.status).toBe(200);
    expect(await systemTexts(bTok, ch.id)).toEqual([
      "a nommé Bob admin du salon",
      "a retiré le rôle d'admin à Bob",
    ]);
  });

  it("un admin du chat nomme des admins dans un salon public sans en être membre, et s'y nomme une fois membre", async () => {
    const { token: chatAdmin, user: chatAdminUser } = await registerUser(app);
    const { token: creator, user: creatorUser } = await registerUser(app);
    const { user: b } = await registerUser(app, { displayName: "Bob" });
    const ch = await create(creator, { name: "public", memberIds: [b.id] });

    expect((await setRole(chatAdmin, ch.id, b.id, "admin")).status).toBe(200);
    // Pas membre : il ne peut pas se nommer lui-même.
    const notYet = await setRole(chatAdmin, ch.id, chatAdminUser.id, "admin");
    expect(notYet.status).toBe(404);
    expect(notYet.body.error).toBe("not_a_member");

    await authed(app, chatAdmin).post(`/channels/${ch.id}/join`);
    const self = await setRole(chatAdmin, ch.id, chatAdminUser.id, "admin");
    expect(self.status).toBe(200);
    expect(self.body.channel.adminIds.sort()).toEqual(
      [creatorUser.id, b.id, chatAdminUser.id].sort()
    );
    expect(await systemLog(creator, ch.id)).toEqual([
      { body: "a nommé Bob admin du salon", authorId: chatAdminUser.id },
      { body: "a rejoint le salon", authorId: chatAdminUser.id },
      { body: "est maintenant admin du salon", authorId: chatAdminUser.id },
    ]);
  });

  it("le bot technique ne peut pas être nommé admin", async () => {
    await registerUser(app);
    const { token: creator } = await registerUser(app);
    const ch = await create(creator, { name: "avec-bot", isPrivate: true });
    // Un ancien groupe pouvait inclure le bot (il était proposé avant la 1.6.0).
    const bot = await ensureBot();
    await prisma.membership.create({ data: { userId: bot.id, channelId: ch.id } });

    const res = await setRole(creator, ch.id, bot.id, "admin");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bot_protected");
    expect(await adminsOf(ch.id)).not.toContain(bot.id);
  });

  it("deux admins qui se retirent le rôle au même instant : l'un des deux le reste", async () => {
    await registerUser(app);
    const { token: aTok, user: a } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app);
    const ch = await create(aTok, { name: "duo", memberIds: [b.id] });
    await setRole(aTok, ch.id, b.id, "admin");

    const results = await Promise.all([
      setRole(aTok, ch.id, a.id, "member"),
      setRole(bTok, ch.id, b.id, "member"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await adminsOf(ch.id)).toHaveLength(1);
  });
});

describe("départs : retirer un admin, le dernier admin qui part, un salon vide qu'on rejoint", () => {
  it("un simple membre ne retire pas un admin du salon ; un admin du salon, si", async () => {
    await registerUser(app);
    const { token: creator, user: creatorUser } = await registerUser(app);
    const { user: b } = await registerUser(app, { displayName: "Bob" });
    const { token: cTok, user: c } = await registerUser(app, { displayName: "Chloé" });
    const { user: d } = await registerUser(app, { displayName: "Dan" });
    const ch = await create(creator, { name: "equipe", memberIds: [b.id, c.id, d.id] });
    await setRole(creator, ch.id, b.id, "admin");

    const refused = await authed(app, cTok).delete(`/channels/${ch.id}/members/${b.id}`);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("admin_only");
    expect(
      (await authed(app, cTok).delete(`/channels/${ch.id}/members/${creatorUser.id}`)).body.error
    ).toBe("admin_only");
    // Un simple membre en retire toujours un autre.
    expect((await authed(app, cTok).delete(`/channels/${ch.id}/members/${d.id}`)).status).toBe(200);

    expect((await authed(app, creator).delete(`/channels/${ch.id}/members/${b.id}`)).status).toBe(
      200
    );
    expect(await adminsOf(ch.id)).toEqual([creatorUser.id]);
    expect(await systemTexts(creator, ch.id)).toEqual([
      "a nommé Bob admin du salon",
      "a retiré Dan du salon",
      "a retiré Bob du salon",
    ]);
  });

  it("un admin du chat retire le dernier admin du salon : le plus ancien membre prend le relais", async () => {
    const { token: chatAdmin, user: chatAdminUser } = await registerUser(app);
    const { token: creator, user: creatorUser } = await registerUser(app, {
      displayName: "Charles",
    });
    const { token: bTok, user: b } = await registerUser(app);
    const ch = await create(creator, { name: "modere", memberIds: [b.id] });
    await authed(app, chatAdmin).post(`/channels/${ch.id}/join`);
    await setJoinedAt(b.id, ch.id, "2026-01-01");
    await setJoinedAt(chatAdminUser.id, ch.id, "2026-02-01");

    const res = await authed(app, chatAdmin).delete(`/channels/${ch.id}/members/${creatorUser.id}`);
    expect(res.status).toBe(200);
    expect(await adminIdsSeenBy(bTok, ch.id)).toEqual([b.id]);
    expect(await systemLog(bTok, ch.id)).toEqual([
      { body: "a rejoint le salon", authorId: chatAdminUser.id },
      { body: "a retiré Charles du salon", authorId: chatAdminUser.id },
      { body: "est maintenant admin du salon", authorId: b.id },
    ]);
  });

  it("le dernier admin qui part : le plus ancien membre actif le devient (bot et compte désactivé exclus)", async () => {
    await registerUser(app);
    const { token: creator, user: creatorUser } = await registerUser(app);
    const { user: off } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app);
    const { user: c } = await registerUser(app);
    const ch = await create(creator, {
      name: "succession",
      isPrivate: true,
      memberIds: [off.id, b.id, c.id],
    });
    const bot = await ensureBot();
    await prisma.membership.create({
      data: { userId: bot.id, channelId: ch.id, joinedAt: new Date("2025-12-01") },
    });
    await setJoinedAt(off.id, ch.id, "2026-01-01");
    await setJoinedAt(b.id, ch.id, "2026-01-02");
    await setJoinedAt(c.id, ch.id, "2026-01-03");
    await prisma.user.update({ where: { id: off.id }, data: { status: "disabled" } });

    expect((await authed(app, creator).post(`/channels/${ch.id}/leave`)).status).toBe(200);
    expect(await adminIdsSeenBy(bTok, ch.id)).toEqual([b.id]);
    expect(await systemLog(bTok, ch.id)).toEqual([
      { body: "a quitté le salon", authorId: creatorUser.id },
      { body: "est maintenant admin du salon", authorId: b.id },
    ]);
  });

  it("sans membre actif, personne n'est nommé ; un admin qui part en laissant un autre admin ne change rien", async () => {
    await registerUser(app);
    const { token: creator, user: creatorUser } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app);
    const { user: off } = await registerUser(app);
    const solo = await create(creator, { name: "fantome", isPrivate: true, memberIds: [off.id] });
    await prisma.user.update({ where: { id: off.id }, data: { status: "disabled" } });
    await authed(app, creator).post(`/channels/${solo.id}/leave`);
    // Un compte désactivé ne compterait pas comme admin (1.6.2).
    expect(await adminsOf(solo.id)).toEqual([]);

    const duo = await create(creator, { name: "duo", memberIds: [b.id] });
    await setRole(creator, duo.id, b.id, "admin");
    await authed(app, creator).post(`/channels/${duo.id}/leave`);
    expect(await adminsOf(duo.id)).toEqual([b.id]);
    expect(await systemLog(bTok, duo.id)).toEqual([
      { body: "a nommé " + b.displayName + " admin du salon", authorId: creatorUser.id },
      { body: "a quitté le salon", authorId: creatorUser.id },
    ]);
  });

  it("rejoindre un salon public resté vide : on en devient l'admin, les suivants sont membres", async () => {
    await registerUser(app);
    const { token: creator } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app);
    const { token: cTok, user: c } = await registerUser(app);
    const pub = await create(creator, { name: "vide" });
    await authed(app, creator).post(`/channels/${pub.id}/leave`);
    expect(await adminsOf(pub.id)).toEqual([]);

    const joined = await authed(app, bTok).post(`/channels/${pub.id}/join`);
    expect(joined.status).toBe(200);
    expect(joined.body.channel.adminIds).toEqual([b.id]);
    const next = await authed(app, cTok).post(`/channels/${pub.id}/join`);
    expect(next.body.channel.adminIds).toEqual([b.id]);
    expect(await systemLog(cTok, pub.id)).toEqual([
      { body: "a rejoint le salon", authorId: b.id },
      { body: "est maintenant admin du salon", authorId: b.id },
      { body: "a rejoint le salon", authorId: c.id },
    ]);
  });

  // Départs simultanés : jamais zéro admin une fois tous les appels terminés.
  it("les deux admins partent au même instant : le membre restant le devient, une seule fois", async () => {
    await registerUser(app);
    const { token: aTok } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app);
    const { token: cTok, user: c } = await registerUser(app);
    const ch = await create(aTok, { name: "exode", memberIds: [b.id, c.id] });
    await setRole(aTok, ch.id, b.id, "admin");

    const left = await Promise.all([
      authed(app, aTok).post(`/channels/${ch.id}/leave`),
      authed(app, bTok).post(`/channels/${ch.id}/leave`),
    ]);
    expect(left.map((r) => r.status)).toEqual([200, 200]);
    expect(await adminsOf(ch.id)).toEqual([c.id]);
    const promotions = (await systemLog(cTok, ch.id)).filter(
      (m) => m.body === "est maintenant admin du salon"
    );
    expect(promotions).toEqual([{ body: "est maintenant admin du salon", authorId: c.id }]);
  });

  it("un admin se retire le rôle pendant que l'autre part : il en reste un", async () => {
    await registerUser(app);
    const { token: aTok, user: a } = await registerUser(app);
    const { token: bTok, user: b } = await registerUser(app);
    const { token: cTok, user: c } = await registerUser(app);
    const ch = await create(aTok, { name: "bascule", memberIds: [b.id, c.id] });
    await setRole(aTok, ch.id, b.id, "admin");
    await setJoinedAt(c.id, ch.id, "2026-01-01");
    await setJoinedAt(a.id, ch.id, "2026-01-02");

    const [demoted, left] = await Promise.all([
      setRole(aTok, ch.id, a.id, "member"),
      authed(app, bTok).post(`/channels/${ch.id}/leave`),
    ]);
    expect(left.status).toBe(200);
    // Selon l'ordre d'arrivée : Alice cesse d'être admin avant le départ de Bob,
    // et le plus ancien membre (Chloé) prend le relais ; ou Bob est déjà parti,
    // et Alice, dernière admin, garde son rôle.
    expect([200, 409]).toContain(demoted.status);
    const handedOver = demoted.status === 200;
    expect(await adminsOf(ch.id)).toEqual([handedOver ? c.id : a.id]);
    const promotions = (await systemTexts(cTok, ch.id)).filter(
      (t) => t === "est maintenant admin du salon"
    );
    expect(promotions).toHaveLength(handedOver ? 1 : 0);
  });
});

describe("ensureSalonAdmins — rattrapage au démarrage", () => {
  it("donne un admin actif à chaque salon géré qui n'en a pas, en silence, une seule fois", async () => {
    const { user: admin } = await registerUser(app);
    const { user: alice } = await registerUser(app);
    const { token: bobTok, user: bob } = await registerUser(app);
    const { user: carol } = await registerUser(app);
    const { user: dan } = await registerUser(app);
    const bot = await ensureBot();
    const def = await ensureDefaultChannel();
    await prisma.user.update({ where: { id: dan.id }, data: { status: "disabled" } });

    // Salons d'avant les rôles : tout le monde y est « member ».
    const legacy = (data, members) =>
      prisma.channel.create({
        data: {
          ...data,
          memberships: {
            create: members.map(([userId, joinedAt]) => ({ userId, joinedAt: new Date(joinedAt) })),
          },
        },
      });
    const byCreator = await legacy({ name: "createur", createdById: bob.id }, [
      [alice.id, "2026-01-01"],
      [bob.id, "2026-01-02"],
    ]);
    const creatorGone = await legacy({ name: "orphelin", createdById: admin.id }, [
      [dan.id, "2026-01-01"],
      [carol.id, "2026-01-02"],
      [alice.id, "2026-01-03"],
    ]);
    const creatorDisabled = await legacy({ name: "createur-desactive", createdById: dan.id }, [
      [carol.id, "2026-01-01"],
      [dan.id, "2026-01-02"],
    ]);
    const withBot = await legacy({ name: "avec-bot", isPrivate: true }, [
      [bot.id, "2026-01-01"],
      [carol.id, "2026-01-02"],
    ]);
    const onlyDisabled = await legacy({ name: "fantome", isPrivate: true }, [[dan.id, "2026-01-01"]]);
    const onlyBot = await legacy({ name: "que-le-bot", createdById: bot.id }, [
      [bot.id, "2026-01-01"],
    ]);
    // Laissé par une 1.6.1 : son seul admin est un compte désactivé.
    const staleAdmin = await prisma.channel.create({
      data: {
        name: "admin-desactive",
        createdById: dan.id,
        memberships: {
          create: [
            { userId: dan.id, role: "admin", joinedAt: new Date("2026-01-01") },
            { userId: bob.id, joinedAt: new Date("2026-01-02") },
            { userId: alice.id, joinedAt: new Date("2026-01-03") },
          ],
        },
      },
    });
    const settled = await prisma.channel.create({
      data: {
        name: "deja-pourvu",
        memberships: {
          create: [
            { userId: alice.id, joinedAt: new Date("2026-01-01") },
            { userId: bob.id, role: "admin", joinedAt: new Date("2026-01-02") },
          ],
        },
      },
    });
    const dm = await legacy({ isDirect: true }, [
      [alice.id, "2026-01-01"],
      [bob.id, "2026-01-02"],
    ]);
    const expert = await legacy({ kind: "claude", isPrivate: true, name: "Expert", createdById: alice.id }, [
      [alice.id, "2026-01-01"],
      [bot.id, "2026-01-02"],
    ]);
    const support = await legacy({ name: "support-dev", isPrivate: true }, [[admin.id, "2026-01-01"]]);

    expect(await ensureSalonAdmins()).toBe(5);
    expect(await adminsOf(byCreator.id)).toEqual([bob.id]); // le créateur, pas le plus ancien
    expect(await adminsOf(creatorGone.id)).toEqual([carol.id]); // Dan, désactivé, passe son tour
    // Encore membre, le créateur ne passe devant qu'avec un compte actif.
    expect(await adminsOf(creatorDisabled.id)).toEqual([carol.id]);
    expect(await adminsOf(withBot.id)).toEqual([carol.id]); // jamais le bot
    // Personne d'actif : personne à nommer (un compte désactivé ne compterait pas).
    expect(await adminsOf(onlyDisabled.id)).toEqual([]);
    expect(await adminsOf(onlyBot.id)).toEqual([]);
    // Dan garde son rôle (il le retrouvera s'il est réactivé), mais ne compte
    // plus : le plus ancien membre actif reprend le salon.
    expect(await adminsOf(staleAdmin.id)).toEqual([dan.id, bob.id].sort());
    expect(await adminIdsSeenBy(bobTok, staleAdmin.id)).toEqual([bob.id]);
    expect(await adminsOf(settled.id)).toEqual([bob.id]);
    for (const c of [dm, expert, support, def]) expect(await adminsOf(c.id)).toEqual([]);
    // Personne n'a rien fait : aucun message de service.
    expect(await prisma.message.count()).toBe(0);

    // Idempotent.
    expect(await ensureSalonAdmins()).toBe(0);
    expect(await prisma.membership.count({ where: { role: "admin" } })).toBe(7);
  });
});

describe("compte désactivé : il n'est plus admin du salon (1.6.2)", () => {
  const setStatus = (token, userId, status) =>
    authed(app, token).patch(`/auth/users/${userId}`).send({ status });

  it("désactiver le dernier admin actif : le plus ancien membre actif prend le relais ; réactivé, il retrouve son rôle", async () => {
    const { token: owner } = await registerUser(app);
    const { token: aliceTok, user: alice } = await registerUser(app);
    const { token: bobTok, user: bob } = await registerUser(app);
    const { user: carol } = await registerUser(app);
    const { user: dan } = await registerUser(app);
    // Seule admin du salon : Carol, plus ancien membre actif (Dan est désactivé), reprend.
    const solo = await create(aliceTok, {
      name: "relais",
      isPrivate: true,
      memberIds: [bob.id, carol.id, dan.id],
    });
    await setJoinedAt(dan.id, solo.id, "2026-01-01");
    await setJoinedAt(carol.id, solo.id, "2026-01-02");
    await setJoinedAt(bob.id, solo.id, "2026-01-03");
    await prisma.user.update({ where: { id: dan.id }, data: { status: "disabled" } });
    // Un autre admin actif y reste : personne à nommer.
    const duo = await create(aliceTok, { name: "duo", memberIds: [bob.id] });
    await setRole(aliceTok, duo.id, bob.id, "admin");
    // Simple membre : rien ne bouge.
    const other = await create(bobTok, { name: "autre", memberIds: [alice.id] });

    const res = await setStatus(owner, alice.id, "disabled");
    expect(res.status).toBe(200);
    // Rien des salons (privés compris) ne remonte à l'admin du chat.
    expect(Object.keys(res.body)).toEqual(["user"]);

    expect(await adminIdsSeenBy(bobTok, solo.id)).toEqual([carol.id]);
    expect(await adminsOf(solo.id)).toEqual([alice.id, carol.id].sort()); // son rôle est gardé
    expect(await systemLog(bobTok, solo.id)).toEqual([
      { body: "est maintenant admin du salon", authorId: carol.id },
    ]);
    expect(await adminIdsSeenBy(bobTok, duo.id)).toEqual([bob.id]);
    expect(await systemTexts(bobTok, duo.id)).toEqual([`a nommé ${bob.displayName} admin du salon`]);
    expect(await adminIdsSeenBy(bobTok, other.id)).toEqual([bob.id]);
    expect(await systemTexts(bobTok, other.id)).toEqual([]);

    // Réactivée, elle retrouve son rôle, à côté de qui a pris le relais, en silence.
    expect((await setStatus(owner, alice.id, "active")).status).toBe(200);
    expect((await adminIdsSeenBy(bobTok, solo.id)).sort()).toEqual([alice.id, carol.id].sort());
    expect((await adminIdsSeenBy(bobTok, duo.id)).sort()).toEqual([alice.id, bob.id].sort());
    expect(await systemTexts(bobTok, solo.id)).toEqual(["est maintenant admin du salon"]);
  });

  it("un admin désactivé ne compte plus : dernier admin actif, nomination refusée, retrait par un simple membre", async () => {
    const { token: owner } = await registerUser(app);
    const { token: aliceTok, user: alice } = await registerUser(app);
    const { token: bobTok, user: bob } = await registerUser(app);
    const { token: carolTok, user: carol } = await registerUser(app);
    const { user: dan } = await registerUser(app);
    const ch = await create(aliceTok, { name: "equipe", memberIds: [bob.id, carol.id, dan.id] });
    await setRole(aliceTok, ch.id, bob.id, "admin");
    await setStatus(owner, alice.id, "disabled");
    await setStatus(owner, dan.id, "disabled");

    // Bob est le dernier admin actif : Alice, désactivée, ne prend pas le relais.
    const demoted = await setRole(bobTok, ch.id, bob.id, "member");
    expect(demoted.status).toBe(409);
    expect(demoted.body.error).toBe("last_admin");
    const named = await setRole(bobTok, ch.id, dan.id, "admin");
    expect(named.status).toBe(403);
    expect(named.body.error).toBe("target_disabled");
    // Un simple membre retire l'admin désactivée comme un simple membre.
    expect((await authed(app, carolTok).delete(`/channels/${ch.id}/members/${alice.id}`)).status).toBe(
      200
    );
    expect(await adminsOf(ch.id)).toEqual([bob.id]);
    expect(await adminIdsSeenBy(carolTok, ch.id)).toEqual([bob.id]);
  });

  it("réactiver un membre d'un salon resté sans admin actif : il le reprend", async () => {
    const { token: owner } = await registerUser(app);
    const { token: aliceTok, user: alice } = await registerUser(app);
    const { token: bobTok, user: bob } = await registerUser(app);
    const ch = await create(aliceTok, { name: "veille", isPrivate: true, memberIds: [bob.id] });
    await setStatus(owner, bob.id, "disabled");
    await setStatus(owner, alice.id, "disabled");
    // Plus personne d'actif : personne à nommer, Alice garde son rôle inerte.
    expect(await adminsOf(ch.id)).toEqual([alice.id]);

    expect((await setStatus(owner, bob.id, "active")).status).toBe(200);
    expect(await adminIdsSeenBy(bobTok, ch.id)).toEqual([bob.id]);
    expect(await systemLog(bobTok, ch.id)).toEqual([
      { body: "est maintenant admin du salon", authorId: bob.id },
    ]);
  });

  // Création et désactivation simultanées : jamais un salon dont le seul admin
  // est un compte désactivé, quel que soit l'ordre d'arrivée.
  it("désactiver un compte pendant qu'il crée un salon : le salon garde un admin actif", async () => {
    const { token: owner } = await registerUser(app);
    const { token: aliceTok, user: alice } = await registerUser(app);
    const { token: bobTok, user: bob } = await registerUser(app);
    const [created, disabled] = await Promise.all([
      authed(app, aliceTok).post("/channels").send({ name: "course", memberIds: [bob.id] }),
      setStatus(owner, alice.id, "disabled"),
    ]);
    expect(disabled.status).toBe(200);
    // Désactivée avant l'authentification de sa requête : refusée. Sinon, Bob
    // reprend le salon, annoncé comme à toute désactivation.
    expect([200, 401]).toContain(created.status);
    if (created.status === 200) {
      const id = created.body.channel.id;
      expect(await adminIdsSeenBy(bobTok, id)).toEqual([bob.id]);
      expect(await systemLog(bobTok, id)).toEqual([
        { body: "est maintenant admin du salon", authorId: bob.id },
      ]);
    }
  });

  it("rejoindre un salon public dont le seul admin est désactivé : on le reprend", async () => {
    const { token: owner } = await registerUser(app);
    const { token: aliceTok, user: alice } = await registerUser(app);
    const { token: bobTok, user: bob } = await registerUser(app);
    const pub = await create(aliceTok, { name: "ouvert" });
    await setStatus(owner, alice.id, "disabled");

    const joined = await authed(app, bobTok).post(`/channels/${pub.id}/join`);
    expect(joined.status).toBe(200);
    expect(joined.body.channel.adminIds).toEqual([bob.id]);
    expect(await systemLog(bobTok, pub.id)).toEqual([
      { body: "a rejoint le salon", authorId: bob.id },
      { body: "est maintenant admin du salon", authorId: bob.id },
    ]);
  });
});
