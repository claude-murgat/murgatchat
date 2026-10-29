import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  startTestServer,
  connectSocket,
  waitForEvent,
  expectNoEvent,
  waitInRoom,
} from "../helpers/server.js";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";
import { ensureSalonAdmins } from "../../src/routes/channels.ts";

// Temps réel des salons gérés par leurs membres (1.6.0) : messages de service
// diffusés sans notification, retrait expliqué à la personne concernée, ajout
// annoncé, masquage d'un DM synchronisé entre appareils ; admins du salon
// (`adminIds` sur channel:created et channel:members) aux seuls membres, y
// compris ceux que le rattrapage du démarrage désigne.

let srv;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});

const open = [];
const track = (s) => {
  open.push(s);
  return s;
};
afterEach(() => {
  for (const s of open) s.disconnect();
  open.length = 0;
});

async function ready(token, channelId) {
  const s = track(await connectSocket(srv.url, token));
  if (channelId) await waitInRoom(srv.io, channelId, s.id);
  return s;
}

const send = (socket, payload) =>
  new Promise((resolve) => socket.emit("message:send", payload, resolve));

describe("salons gérés par leurs membres — temps réel", () => {
  it("retirer quelqu'un : il apprend par qui, les autres voient la trace, sans notification", async () => {
    const alice = await registerUser(srv.app, { displayName: "Alice" });
    const bob = await registerUser(srv.app, { displayName: "Bob" });
    const carol = await registerUser(srv.app, { displayName: "Carol" });
    const ch = (
      await authed(srv.app, alice.token)
        .post("/channels")
        .send({ name: "equipe", isPrivate: true, memberIds: [bob.user.id, carol.user.id] })
    ).body.channel;
    const bobSock = await ready(bob.token, ch.id);
    const carolSock = await ready(carol.token, ch.id);

    const removed = waitForEvent(bobSock, "channel:removed");
    // Évènement propre aux messages de service : un client antérieur, qui
    // n'écoute que message:new, n'en fait pas un non-lu.
    const trace = waitForEvent(carolSock, "message:system");
    const silent = expectNoEvent(carolSock, "notification", 800);
    const notNew = expectNoEvent(carolSock, "message:new", 800);
    await authed(srv.app, alice.token).delete(`/channels/${ch.id}/members/${bob.user.id}`);

    expect(await removed).toMatchObject({
      channelId: ch.id,
      reason: "removed",
      by: { id: alice.user.id, displayName: "Alice" },
      channelName: "equipe",
    });
    expect(await trace).toMatchObject({
      channelId: ch.id,
      kind: "system",
      body: "a retiré Bob du salon",
      author: { id: alice.user.id },
    });
    await silent;
    await notNew;
  });

  it("ajouter quelqu'un : il reçoit le salon avec le nom de qui l'a ajouté", async () => {
    const alice = await registerUser(srv.app, { displayName: "Alice" });
    const bob = await registerUser(srv.app);
    const ch = (
      await authed(srv.app, alice.token).post("/channels").send({ name: "projet", isPrivate: true })
    ).body.channel;
    const bobSock = await ready(bob.token);

    const created = waitForEvent(bobSock, "channel:created", (c) => c.id === ch.id);
    await authed(srv.app, alice.token)
      .post(`/channels/${ch.id}/members`)
      .send({ userIds: [bob.user.id] });
    expect(await created).toMatchObject({
      id: ch.id,
      addedBy: { id: alice.user.id, displayName: "Alice" },
      adminIds: [alice.user.id],
    });
  });

  it("un changement de rôle diffuse channel:members avec adminIds aux membres, rien aux autres", async () => {
    await registerUser(srv.app); // admin du chat
    const alice = await registerUser(srv.app, { displayName: "Alice" });
    const bob = await registerUser(srv.app, { displayName: "Bob" });
    const eve = await registerUser(srv.app);
    const ch = (
      await authed(srv.app, alice.token)
        .post("/channels")
        .send({ name: "equipe", isPrivate: true, memberIds: [bob.user.id] })
    ).body.channel;
    const bobSock = await ready(bob.token, ch.id);
    const eveSock = await ready(eve.token);

    const members = waitForEvent(bobSock, "channel:members", (e) => e.channelId === ch.id);
    const trace = waitForEvent(bobSock, "message:system");
    const eveSilent = expectNoEvent(eveSock, "channel:members", 800);
    const eveNoTrace = expectNoEvent(eveSock, "message:system", 800);
    const res = await authed(srv.app, alice.token)
      .patch(`/channels/${ch.id}/members/${bob.user.id}`)
      .send({ role: "admin" });
    expect(res.status).toBe(200);

    const evt = await members;
    expect(evt.adminIds.sort()).toEqual([alice.user.id, bob.user.id].sort());
    expect(evt.members.map((m) => m.id).sort()).toEqual([alice.user.id, bob.user.id].sort());
    expect(await trace).toMatchObject({
      channelId: ch.id,
      kind: "system",
      body: "a nommé Bob admin du salon",
      author: { id: alice.user.id },
    });
    await eveSilent;
    await eveNoTrace;
  });

  it("le dernier admin parti, les membres apprennent qui le remplace", async () => {
    await registerUser(srv.app);
    const alice = await registerUser(srv.app);
    const bob = await registerUser(srv.app);
    const ch = (
      await authed(srv.app, alice.token)
        .post("/channels")
        .send({ name: "relais", memberIds: [bob.user.id] })
    ).body.channel;
    const bobSock = await ready(bob.token, ch.id);

    // Le premier channel:members (départ d'Alice) n'a encore personne.
    const promoted = waitForEvent(
      bobSock,
      "channel:members",
      (e) => e.channelId === ch.id && e.adminIds.length > 0
    );
    const trace = waitForEvent(
      bobSock,
      "message:system",
      (m) => m.body === "est maintenant admin du salon"
    );
    await authed(srv.app, alice.token).post(`/channels/${ch.id}/leave`);
    expect((await promoted).adminIds).toEqual([bob.user.id]);
    expect((await trace).author.id).toBe(bob.user.id);
  });

  it("le rattrapage du démarrage met à jour les clients déjà connectés, sans message de service", async () => {
    await registerUser(srv.app);
    const alice = await registerUser(srv.app);
    const bob = await registerUser(srv.app);
    // Un salon d'avant les admins du salon (tout le monde « member ») : le
    // serveur écoute déjà quand le rattrapage passe, Bob s'est reconnecté avant.
    const ch = await prisma.channel.create({
      data: {
        name: "ancien",
        createdById: alice.user.id,
        memberships: { create: [{ userId: alice.user.id }, { userId: bob.user.id }] },
      },
    });
    const bobSock = await ready(bob.token, ch.id);
    const members = waitForEvent(bobSock, "channel:members", (e) => e.channelId === ch.id);
    const noTrace = expectNoEvent(bobSock, "message:system", 800);

    expect(await ensureSalonAdmins(srv.io)).toBe(1);
    expect((await members).adminIds).toEqual([alice.user.id]);
    await noTrace;
  });

  it("on ne répond pas à un message de service", async () => {
    const alice = await registerUser(srv.app);
    const ch = (await authed(srv.app, alice.token).post("/channels").send({ name: "fige" })).body
      .channel;
    await authed(srv.app, alice.token).patch(`/channels/${ch.id}`).send({ name: "fige-2" });
    const sys = (
      await authed(srv.app, alice.token).get(`/channels/${ch.id}/messages`)
    ).body.messages.find((m) => m.kind === "system");
    const sock = await ready(alice.token, ch.id);
    const ack = await send(sock, { channelId: ch.id, body: "réponse", parentId: sys.id });
    expect(ack).toEqual({ error: "invalid_parent" });
  });

  it("un message dans une conversation masquée la fait revenir chez celui qui l'a masquée", async () => {
    const alice = await registerUser(srv.app);
    const bob = await registerUser(srv.app);
    const dm = (
      await authed(srv.app, alice.token).post("/channels/dm").send({ userId: bob.user.id })
    ).body.channel;
    await authed(srv.app, alice.token).post(`/channels/${dm.id}/hide`);
    const aliceSock = await ready(alice.token, dm.id);
    const bobSock = await ready(bob.token, dm.id);

    const back = waitForEvent(aliceSock, "channel:hidden", (e) => e.hiddenAt === null);
    expect((await send(bobSock, { channelId: dm.id, body: "tu es là ?" })).ok).toBe(true);
    expect((await back).channelId).toBe(dm.id);
    const listed = (await authed(srv.app, alice.token).get("/channels")).body.channels.find(
      (c) => c.id === dm.id
    );
    expect(listed.hiddenAt).toBeNull();
  });

  it("« marquer non lu » d'un salon dont on n'est pas membre ne renvoie rien", async () => {
    const alice = await registerUser(srv.app);
    const eve = await registerUser(srv.app);
    const ch = (
      await authed(srv.app, alice.token).post("/channels").send({ name: "secret", isPrivate: true })
    ).body.channel;
    const aliceSock = await ready(alice.token, ch.id);
    await send(aliceSock, { channelId: ch.id, body: "message" });
    const eveA = await ready(eve.token);
    const eveB = await ready(eve.token);
    const silent = expectNoEvent(eveB, "channel:unread", 600);
    eveA.emit("channel:unread", { channelId: ch.id });
    await silent;
  });

  it("masquer un DM le retire aussi des autres appareils de l'utilisateur", async () => {
    const alice = await registerUser(srv.app);
    const bob = await registerUser(srv.app);
    const dm = (
      await authed(srv.app, alice.token).post("/channels/dm").send({ userId: bob.user.id })
    ).body.channel;
    const phone = await ready(alice.token, dm.id);
    const bobSock = await ready(bob.token, dm.id);

    const synced = waitForEvent(phone, "channel:hidden");
    const bobUnaware = expectNoEvent(bobSock, "channel:hidden", 600);
    await authed(srv.app, alice.token).post(`/channels/${dm.id}/hide`);
    const evt = await synced;
    expect(evt.channelId).toBe(dm.id);
    expect(evt.hiddenAt).toBeTruthy();
    await bobUnaware;
  });
});
