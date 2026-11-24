import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/index.ts";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

// Un salon avec son créateur (admin du salon) et deux membres. Le premier
// compte inscrit (base vidée avant chaque test) est l'admin du chat : on le crée
// à part, hors du salon, pour que les trois autres soient des comptes ordinaires.
async function setup({ isPrivate = false } = {}) {
  const admin = await registerUser(app);
  const owner = await registerUser(app);
  const member = await registerUser(app);
  const other = await registerUser(app);
  const ch = (
    await authed(app, owner.token)
      .post("/channels")
      .send({ name: `sondage-${Date.now().toString(36)}`, isPrivate })
  ).body.channel;
  await authed(app, owner.token)
    .post(`/channels/${ch.id}/members`)
    .send({ userIds: [member.user.id, other.user.id] });
  return { admin, owner, member, other, channelId: ch.id };
}

const create = (token, body) => authed(app, token).post("/polls").send(body);
const vote = (token, pollId, optionIds) =>
  authed(app, token).put(`/polls/${pollId}/votes`).send({ optionIds });
const addOption = (token, pollId, text) =>
  authed(app, token).post(`/polls/${pollId}/options`).send({ text });
const close = (token, pollId) => authed(app, token).post(`/polls/${pollId}/close`).send({});

async function newPoll(ctx, extra = {}) {
  const res = await create(ctx.member.token, {
    channelId: ctx.channelId,
    question: "On mange où vendredi ?",
    options: ["Pizzeria", "Japonais", "Cantine"],
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.message;
}

describe("POST /polls", () => {
  it("publie le sondage comme un message, avec son texte de repli", async () => {
    const ctx = await setup();
    const msg = await newPoll(ctx, { multiple: true, allowAddOptions: true });
    expect(msg.channelId).toBe(ctx.channelId);
    expect(msg.author.id).toBe(ctx.member.user.id);
    expect(msg.body).toBe("📊 Sondage : On mange où vendredi ?");
    expect(msg.poll).toMatchObject({
      question: "On mange où vendredi ?",
      multiple: true,
      allowAddOptions: true,
      closedAt: null,
      voterCount: 0,
    });
    expect(msg.poll.options.map((o) => o.text)).toEqual(["Pizzeria", "Japonais", "Cantine"]);
    expect(msg.poll.options.every((o) => o.count === 0 && o.voters.length === 0)).toBe(true);

    // Chiffré au repos, comme le corps des messages.
    const row = await prisma.poll.findUnique({ where: { id: msg.poll.id }, include: { options: true } });
    expect(row.question).not.toContain("vendredi");
    expect(row.options.some((o) => o.text.includes("Pizzeria"))).toBe(false);

    // Et dans le fil, pour tous les membres.
    const list = await authed(app, ctx.other.token).get(`/channels/${ctx.channelId}/messages`);
    const inList = list.body.messages.find((m) => m.id === msg.id);
    expect(inList.poll.question).toBe("On mange où vendredi ?");
    expect(inList.poll.options).toHaveLength(3);
    // Les autres messages portent `poll: null`.
    expect(list.body.messages.filter((m) => m.id !== msg.id).every((m) => m.poll === null)).toBe(true);
  });

  it("choix unique et réponses fermées par défaut ; ignore les réponses vides", async () => {
    const ctx = await setup();
    const msg = await newPoll(ctx, { options: ["  Oui ", "", "Non", "   "] });
    expect(msg.poll.multiple).toBe(false);
    expect(msg.poll.allowAddOptions).toBe(false);
    expect(msg.poll.options.map((o) => o.text)).toEqual(["Oui", "Non"]);
  });

  it("refuse une question vide ou trop longue, moins de 2 réponses, plus de 20, les doublons", async () => {
    const ctx = await setup();
    const base = { channelId: ctx.channelId, question: "Q ?", options: ["A", "B"] };
    expect((await create(ctx.member.token, { ...base, question: "  " })).status).toBe(400);
    expect((await create(ctx.member.token, { ...base, question: "x".repeat(301) })).status).toBe(400);
    expect((await create(ctx.member.token, { ...base, options: ["A", ""] })).status).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => `R${i}`);
    expect((await create(ctx.member.token, { ...base, options: many })).body.error).toBe("invalid_option_count");
    expect((await create(ctx.member.token, { ...base, options: ["Oui", " oui "] })).body.error).toBe(
      "duplicate_option"
    );
    expect((await create(ctx.member.token, { ...base, options: ["A", "x".repeat(101)] })).status).toBe(400);
    expect((await create(ctx.member.token, { ...base, multiple: "oui" })).status).toBe(400);
  });

  it("réservé aux membres d'un salon : pas de non-membre, ni de message direct", async () => {
    const ctx = await setup();
    const stranger = await registerUser(app);
    const body = { channelId: ctx.channelId, question: "Q ?", options: ["A", "B"] };
    expect((await create(stranger.token, body)).status).toBe(403);

    const dm = (await authed(app, ctx.owner.token).post("/channels/dm").send({ userId: ctx.member.user.id }))
      .body.channel;
    const inDm = await create(ctx.owner.token, { ...body, channelId: dm.id });
    expect(inDm.status).toBe(400);
    expect(inDm.body.error).toBe("polls_in_salons_only");
  });

  it("le message d'un sondage ne se modifie pas ; le supprimer emporte le sondage", async () => {
    const ctx = await setup();
    const msg = await newPoll(ctx);
    const edit = await authed(app, ctx.member.token)
      .patch(`/channels/messages/${msg.id}`)
      .send({ body: "autre chose" });
    expect(edit.status).toBe(400);
    expect(edit.body.error).toBe("poll_not_editable");

    await vote(ctx.other.token, msg.poll.id, [msg.poll.options[0].id]);
    expect((await authed(app, ctx.member.token).delete(`/channels/messages/${msg.id}`)).status).toBe(200);
    expect(await prisma.poll.findUnique({ where: { id: msg.poll.id } })).toBeNull();
    expect(await prisma.pollVote.count({ where: { userId: ctx.other.user.id } })).toBe(0);
    expect((await vote(ctx.other.token, msg.poll.id, [])).status).toBe(404);
  });
});

describe("PUT /polls/:id/votes", () => {
  it("choix unique : un vote, remplacé par le suivant, retiré par une sélection vide", async () => {
    const ctx = await setup();
    const { poll } = await newPoll(ctx);
    const [a, b] = poll.options;

    const first = await vote(ctx.other.token, poll.id, [a.id]);
    expect(first.status).toBe(200);
    expect(first.body.poll.options[0]).toMatchObject({ count: 1, voters: [{ id: ctx.other.user.id }] });
    expect(first.body.poll.voterCount).toBe(1);

    const moved = await vote(ctx.other.token, poll.id, [b.id]);
    expect(moved.body.poll.options.map((o) => o.count)).toEqual([0, 1, 0]);
    // Chaque changement fait avancer la version (ordre des états côté client).
    expect(poll.version).toBe(0);
    expect(moved.body.poll.version).toBeGreaterThan(first.body.poll.version);

    // Rejouée, la même requête donne le même résultat.
    const again = await vote(ctx.other.token, poll.id, [b.id]);
    expect(again.body.poll.options.map((o) => o.count)).toEqual([0, 1, 0]);

    const cleared = await vote(ctx.other.token, poll.id, []);
    expect(cleared.body.poll.options.map((o) => o.count)).toEqual([0, 0, 0]);
    expect(cleared.body.poll.voterCount).toBe(0);

    const two = await vote(ctx.other.token, poll.id, [a.id, b.id]);
    expect(two.status).toBe(400);
    expect(two.body.error).toBe("single_choice");
  });

  it("choix multiple : plusieurs réponses, votants comptés une fois", async () => {
    const ctx = await setup();
    const { poll } = await newPoll(ctx, { multiple: true });
    const [a, b, c] = poll.options;
    await vote(ctx.other.token, poll.id, [a.id, b.id]);
    const res = await vote(ctx.owner.token, poll.id, [b.id, c.id, c.id]);
    expect(res.body.poll.options.map((o) => o.count)).toEqual([1, 2, 1]);
    expect(res.body.poll.voterCount).toBe(2);
    expect(res.body.poll.options[1].voters.map((v) => v.id).sort()).toEqual(
      [ctx.other.user.id, ctx.owner.user.id].sort()
    );
  });

  it("refuse une réponse d'un autre sondage, un non-membre, un corps invalide", async () => {
    const ctx = await setup();
    const { poll } = await newPoll(ctx);
    const otherPoll = (await newPoll(ctx)).poll;
    const foreign = await vote(ctx.other.token, poll.id, [otherPoll.options[0].id]);
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe("unknown_option");

    const stranger = await registerUser(app);
    expect((await vote(stranger.token, poll.id, [poll.options[0].id])).status).toBe(403);
    expect((await authed(app, ctx.other.token).put(`/polls/${poll.id}/votes`).send({ optionIds: "x" })).status).toBe(
      400
    );
    expect((await vote(ctx.other.token, "inconnu", [])).status).toBe(404);
  });

  it("un salon privé reste fermé aux non-membres, admin du chat compris", async () => {
    const ctx = await setup({ isPrivate: true });
    const { poll } = await newPoll(ctx);
    expect(ctx.admin.user.isAdmin).toBe(true);
    const adminToken = ctx.admin.token;
    expect((await vote(adminToken, poll.id, [poll.options[0].id])).status).toBe(403);
    expect((await close(adminToken, poll.id)).status).toBe(403);
    expect((await addOption(adminToken, poll.id, "Moi aussi")).status).toBe(403);
    const list = await authed(app, adminToken).get(`/channels/${ctx.channelId}/messages`);
    expect(list.status).toBe(403);
  });
});

describe("POST /polls/:id/options", () => {
  it("tout membre ajoute une réponse quand l'auteur l'a permis", async () => {
    const ctx = await setup();
    const { poll } = await newPoll(ctx, { allowAddOptions: true });
    const res = await addOption(ctx.other.token, poll.id, "  Crêperie  ");
    expect(res.status).toBe(200);
    const added = res.body.poll.options.at(-1);
    expect(added).toMatchObject({ text: "Crêperie", addedById: ctx.other.user.id, count: 0 });
    expect(res.body.poll.options).toHaveLength(4);
    // On peut voter pour elle.
    const v = await vote(ctx.owner.token, poll.id, [added.id]);
    expect(v.body.poll.options.at(-1).count).toBe(1);
  });

  it("sinon l'auteur seul ; doublon et 21e réponse refusés", async () => {
    const ctx = await setup();
    const { poll } = await newPoll(ctx);
    const refused = await addOption(ctx.other.token, poll.id, "Crêperie");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("options_locked");

    expect((await addOption(ctx.member.token, poll.id, "Crêperie")).status).toBe(200);
    const dup = await addOption(ctx.member.token, poll.id, "crêperie ");
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("duplicate_option");
    expect((await addOption(ctx.member.token, poll.id, "")).status).toBe(400);
    expect((await addOption(ctx.member.token, poll.id, "x".repeat(101))).status).toBe(400);

    for (let i = 0; i < 16; i++) {
      expect((await addOption(ctx.member.token, poll.id, `Choix ${i}`)).status).toBe(200);
    }
    const full = await addOption(ctx.member.token, poll.id, "Une de trop");
    expect(full.status).toBe(409);
    expect(full.body.error).toBe("too_many_options");
  });

  it("deux ajouts simultanés de la même réponse n'en créent qu'une", async () => {
    const ctx = await setup();
    const { poll } = await newPoll(ctx, { allowAddOptions: true });
    const results = await Promise.all([
      addOption(ctx.other.token, poll.id, "Libanais"),
      addOption(ctx.owner.token, poll.id, "libanais"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const row = await prisma.pollOption.count({ where: { pollId: poll.id } });
    expect(row).toBe(4);
  });
});

describe("POST /polls/:id/close", () => {
  it("l'auteur clôture ; plus de vote ni d'ajout ensuite ; idempotent", async () => {
    const ctx = await setup();
    const { poll } = await newPoll(ctx, { allowAddOptions: true });
    await vote(ctx.other.token, poll.id, [poll.options[0].id]);

    const res = await close(ctx.member.token, poll.id);
    expect(res.status).toBe(200);
    expect(res.body.poll.closedAt).toBeTruthy();
    // Les résultats restent.
    expect(res.body.poll.options[0].count).toBe(1);

    const late = await vote(ctx.other.token, poll.id, [poll.options[1].id]);
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("poll_closed");
    expect((await addOption(ctx.other.token, poll.id, "Trop tard")).status).toBe(409);

    const again = await close(ctx.member.token, poll.id);
    expect(again.status).toBe(200);
    expect(again.body.poll.closedAt).toBe(res.body.poll.closedAt);
    // Clôturer à nouveau ne change rien, pas même la version.
    expect(again.body.poll.version).toBe(res.body.poll.version);
  });

  it("un admin du salon peut clôturer, pas un simple membre", async () => {
    const ctx = await setup();
    const { poll } = await newPoll(ctx);
    const refused = await close(ctx.other.token, poll.id);
    expect(refused.status).toBe(403);
    // `owner` a créé le salon : il en est l'admin.
    expect((await close(ctx.owner.token, poll.id)).status).toBe(200);
  });
});
