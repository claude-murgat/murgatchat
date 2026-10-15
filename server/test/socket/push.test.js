import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createECDH, randomBytes } from "node:crypto";
import webpush from "web-push";
import {
  startTestServer,
  connectSocket,
  newSocket,
  waitConnect,
  waitForEvent,
  expectNoEvent,
  waitInRoom,
} from "../helpers/server.js";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";
import { settleDeferredPushes } from "../../src/socket.ts";

let srv;
beforeAll(async () => {
  // Clés VAPID fournies par l'environnement : sans elles, le premier web push
  // en générerait et les écrirait dans server/data/vapid.json.
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Mock the Expo push endpoint (push.js uses global fetch) so gating is testable
// offline and deterministic. `data` is the tickets array Expo would return.
function mockExpo(data = [{ status: "ok", id: "ticket-1" }]) {
  const fetchMock = vi.fn(async () => ({ json: async () => ({ data }) }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Web Push mocké au niveau de web-push : renvoie l'espion, dont les appels
// portent l'endpoint de chaque abonnement poussé.
function mockWebPush() {
  return vi
    .spyOn(webpush, "sendNotification")
    .mockResolvedValue({ statusCode: 201, body: "", headers: {} });
}

// Abonnement Web Push (PWA) du destinataire. Les clés ne servent pas : l'envoi
// est mocké avant tout chiffrement.
async function subscribeWebPush(userId) {
  const endpoint = `https://fcm.googleapis.com/fcm/send/${userId}`;
  await prisma.webPushSubscription.create({
    data: { userId, endpoint, p256dh: "p256dh", auth: "auth" },
  });
  return endpoint;
}

async function ready(token, channelId, platform = "web", auth = {}) {
  const s = track(await connectSocket(srv.url, token, platform, auth));
  await waitInRoom(srv.io, channelId, s.id);
  return s;
}

// Le client signale qu'il est à l'écran, comme App.tsx à la connexion et
// toutes les 60 s. L'évènement n'a pas d'accusé : on laisse le serveur le
// traiter avant d'envoyer depuis une autre socket.
async function reportActivity(socket) {
  socket.emit("activity");
  await new Promise((r) => setTimeout(r, 150));
}

// author + recipient in a shared channel; recipient has a push token.
async function setup({ recipientToken = true } = {}) {
  const author = await registerUser(srv.app);
  const recipient = await registerUser(srv.app);
  const ch = (await authed(srv.app, author.token).post("/channels").send({ name: "push" })).body.channel;
  await authed(srv.app, author.token).post(`/channels/${ch.id}/members`).send({ userIds: [recipient.user.id] });
  const token = `ExponentPushToken[${recipient.user.username}]`;
  if (recipientToken) {
    await authed(srv.app, recipient.token).post("/auth/push-token").send({ token });
  }
  return { author, recipient, channelId: ch.id, pushToken: token };
}

const send = (socket, payload) =>
  new Promise((resolve) => socket.emit("message:send", payload, resolve));

describe("push gating (notifyMembers)", () => {
  it("pushes to a recipient who is away from web/desktop and not in DnD", async () => {
    const fetchMock = mockExpo();
    const { author, channelId, pushToken } = await setup();
    // recipient never connects a web/desktop socket => considered away.
    const aSock = await ready(author.token, channelId);

    await send(aSock, { channelId, body: "tu es loin" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.map((m) => m.to)).toContain(pushToken);
    expect(body[0].body).toBe("tu es loin");
  });

  it("does NOT push when the recipient's web/desktop is active", async () => {
    const fetchMock = mockExpo();
    const { author, recipient, channelId } = await setup();
    // recipient online on web => recent activity => not away.
    const rSock = await ready(recipient.token, channelId, "web");
    await reportActivity(rSock);
    const aSock = await ready(author.token, channelId);

    const inApp = waitForEvent(rSock, "notification", (n) => n.channelId === channelId);
    // Client antérieur à la sonde (pas de `presenceProbe`) : cru sur parole.
    const noProbe = expectNoEvent(rSock, "presence:probe", 400);
    await send(aSock, { channelId, body: "tu es là" });
    await inApp; // in-app notification still delivered
    await noProbe;
    await settleDeferredPushes();

    expect(fetchMock).not.toHaveBeenCalled(); // but no mobile push
  });

  it("still pushes to a web client that connected but never reported activity (background reconnect)", async () => {
    const fetchMock = mockExpo();
    const { author, recipient, channelId, pushToken } = await setup();
    // Une PWA en arrière-plan qui se reconnecte n'est pas à l'écran : la
    // connexion seule ne vaut pas présence.
    await ready(recipient.token, channelId, "web");
    const aSock = await ready(author.token, channelId);

    await send(aSock, { channelId, body: "reconnecté en arrière-plan" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.map((m) => m.to)).toContain(pushToken);
  });

  it("doesn't drop the presence report a client sends right on connect", async () => {
    const fetchMock = mockExpo();
    const { author, recipient, channelId } = await setup();
    // App.tsx rapporte son état dès l'évènement "connect", pendant que le
    // serveur relit encore le compte en base : l'écouteur doit déjà être posé.
    const rSock = track(newSocket(srv.url, recipient.token, "web"));
    rSock.once("connect", () => rSock.emit("activity"));
    await waitConnect(rSock);
    await waitInRoom(srv.io, channelId, rSock.id);
    const aSock = await ready(author.token, channelId);

    await send(aSock, { channelId, body: "déjà là" });
    await settleDeferredPushes();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pushes once an active recipient signals 'away' (PWA backgrounded)", async () => {
    const fetchMock = mockExpo();
    const { author, recipient, channelId, pushToken } = await setup();
    // recipient online & active on web -> not away (no push yet)...
    const rSock = await ready(recipient.token, channelId, "web");
    const aSock = await ready(author.token, channelId);
    // ...then backgrounds the PWA -> client emits "away" -> immediately away.
    rSock.emit("away");
    await new Promise((r) => setTimeout(r, 150)); // let the server process it

    await send(aSock, { channelId, body: "fenêtre cachée" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.map((m) => m.to)).toContain(pushToken);
  });

  it("sends neither notification nor push when the recipient is in DnD", async () => {
    const fetchMock = mockExpo();
    const { author, recipient, channelId } = await setup();
    await authed(srv.app, recipient.token).post("/auth/dnd").send({ minutes: 60 });
    // mobile platform does not mark web activity, so away-ness isn't the gate here.
    const rSock = await ready(recipient.token, channelId, "mobile");
    const aSock = await ready(author.token, channelId);

    const silent = expectNoEvent(rSock, "notification", 800);
    await send(aSock, { channelId, body: "ne pas déranger" });
    await silent;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends no push to a disabled member (it would carry the message excerpt)", async () => {
    const fetchMock = mockExpo();
    const { author, recipient, channelId } = await setup();
    // author = bootstrap owner; the disabled recipient stays a channel member.
    await authed(srv.app, author.token)
      .patch(`/auth/users/${recipient.user.id}`)
      .send({ status: "disabled" });
    const aSock = await ready(author.token, channelId);

    await send(aSock, { channelId, body: "tu n'es plus là" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prunes a token Expo reports as DeviceNotRegistered", async () => {
    const fetchMock = mockExpo([{ status: "error", details: { error: "DeviceNotRegistered" } }]);
    const { author, channelId, pushToken } = await setup();
    const aSock = await ready(author.token, channelId);

    await send(aSock, { channelId, body: "token mort" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const remaining = await prisma.pushToken.findMany({ where: { token: pushToken } });
    expect(remaining).toHaveLength(0);
  });

  it("emits the in-app notification but skips push when away user has no token", async () => {
    const fetchMock = mockExpo();
    const { author, channelId } = await setup({ recipientToken: false });
    const aSock = await ready(author.token, channelId);

    await send(aSock, { channelId, body: "pas de device" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends neither notification nor push when the recipient muted the channel (notifyLevel=none)", async () => {
    const fetchMock = mockExpo();
    const { author, recipient, channelId } = await setup();
    await authed(srv.app, recipient.token)
      .patch(`/channels/${channelId}/notifications`)
      .send({ level: "none" });
    // recipient connecté mais muet : ni in-app, ni push.
    const rSock = await ready(recipient.token, channelId, "mobile");
    const aSock = await ready(author.token, channelId);

    const silent = expectNoEvent(rSock, "notification", 800);
    await send(aSock, { channelId, body: "canal coupé" });
    await silent;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with notifyLevel=mentions, notifies only when the recipient is mentioned", async () => {
    mockExpo(); // install the Expo push mock (asserted via socket events below, not the mock)
    const { author, recipient, channelId } = await setup();
    await authed(srv.app, recipient.token)
      .patch(`/channels/${channelId}/notifications`)
      .send({ level: "mentions" });
    const rSock = await ready(recipient.token, channelId, "web");
    const aSock = await ready(author.token, channelId);

    // Message sans mention : silence.
    const silent = expectNoEvent(rSock, "notification", 600);
    await send(aSock, { channelId, body: "coucou tout le monde" });
    await silent;

    // Message qui cite le destinataire : notification émise.
    const inApp = waitForEvent(rSock, "notification", (n) => n.channelId === channelId);
    await send(aSock, { channelId, body: `@${recipient.user.username} regarde ça` });
    await inApp;
  });
});

// Clients web récents (`presenceProbe`) : leur dernier "activity" ne suffit
// plus à retenir un push, le serveur leur demande d'abord s'ils sont visibles.
describe("push gating with presence probe (PWA backgrounded without 'away')", () => {
  const probeAuth = { presenceProbe: true };

  async function probeSetup() {
    const { author, recipient, channelId } = await setup({ recipientToken: false });
    const endpoint = await subscribeWebPush(recipient.user.id);
    return { author, recipient, channelId, endpoint };
  }

  it("does NOT push when the probed client answers that it is visible", async () => {
    const sendMock = mockWebPush();
    const { author, recipient, channelId } = await probeSetup();
    const rSock = await ready(recipient.token, channelId, "web", probeAuth);
    let probes = 0;
    rSock.on("presence:probe", (ack) => {
      probes++;
      ack({ visible: true });
    });
    await reportActivity(rSock);
    const aSock = await ready(author.token, channelId);

    await send(aSock, { channelId, body: "je te vois" });
    await settleDeferredPushes();

    expect(probes).toBe(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("pushes once the probe times out on a frozen client, then pushes later messages at once", async () => {
    const sendMock = mockWebPush();
    const { author, recipient, channelId, endpoint } = await probeSetup();
    const rSock = await ready(recipient.token, channelId, "web", probeAuth);
    // PWA gelée par l'OS : la socket est encore ouverte et son dernier
    // "activity" est frais, mais plus rien ne répond.
    let probes = 0;
    rSock.on("presence:probe", () => probes++);
    await reportActivity(rSock);
    const aSock = await ready(author.token, channelId);

    await send(aSock, { channelId, body: "tu dors ?" });
    // Push différé : l'émetteur a son accusé sans attendre la sonde.
    expect(sendMock).not.toHaveBeenCalled();
    await settleDeferredPushes();

    expect(probes).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].endpoint).toBe(endpoint);
    expect(JSON.parse(sendMock.mock.calls[0][1])).toMatchObject({
      body: "tu dors ?",
      channelId,
      tag: `channel:${channelId}`,
    });

    // La socket muette est désormais tenue pour absente : le message suivant
    // part tout de suite, sans nouvelle sonde.
    await send(aSock, { channelId, body: "toujours là ?" });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(probes).toBe(1);
  });

  it("pushes without waiting for the timeout when the probed client says it is hidden", async () => {
    const sendMock = mockWebPush();
    const { author, recipient, channelId } = await probeSetup();
    const rSock = await ready(recipient.token, channelId, "web", probeAuth);
    // "away" perdu, mais la page tourne encore en arrière-plan et répond.
    rSock.on("presence:probe", (ack) => ack({ visible: false }));
    await reportActivity(rSock);
    const aSock = await ready(author.token, channelId);

    const start = Date.now();
    await send(aSock, { channelId, body: "en arrière-plan" });
    await settleDeferredPushes();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("does NOT push to the phone while another device of the user confirms it is visible", async () => {
    const sendMock = mockWebPush();
    const { author, recipient, channelId } = await probeSetup();
    // Téléphone gelé (ne répond pas) + poste de travail visible (répond oui).
    const phone = await ready(recipient.token, channelId, "web", probeAuth);
    phone.on("presence:probe", () => {});
    await reportActivity(phone);
    const desktop = await ready(recipient.token, channelId, "desktop", probeAuth);
    desktop.on("presence:probe", (ack) => ack({ visible: true }));
    await reportActivity(desktop);
    const aSock = await ready(author.token, channelId);

    await send(aSock, { channelId, body: "au bureau" });
    await settleDeferredPushes();

    expect(sendMock).not.toHaveBeenCalled();
  });
});

// Les services push rejettent une charge utile chiffrée de plus de 4 Ko (FCM
// répond 413) : le destinataire d'un long message ne recevait rien.
describe("push payload size", () => {
  const PUSH_SERVICE_MAX_BYTES = 4096;

  it("truncates a very long message so the encrypted web push stays under 4 KB", async () => {
    const fetchMock = mockExpo();
    const { author, recipient, channelId } = await setup();
    // Vraies clés d'abonnement (P-256 + secret) : web-push peut chiffrer, on
    // mesure donc ce qui partirait vraiment au service push.
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    await prisma.webPushSubscription.create({
      data: {
        userId: recipient.user.id,
        endpoint: `https://fcm.googleapis.com/fcm/send/${recipient.user.id}`,
        p256dh: ecdh.getPublicKey("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    });
    const encrypted = [];
    const sendMock = vi
      .spyOn(webpush, "sendNotification")
      .mockImplementation(async (sub, payload, options) => {
        encrypted.push(webpush.generateRequestDetails(sub, payload, options).body);
        return { statusCode: 201, body: "", headers: {} };
      });
    const aSock = await ready(author.token, channelId);

    // Accents (2 octets) et émojis (4 octets) en UTF-8 : bien plus de 4 Ko.
    const body = "Réunion à 14 h 😀 ".repeat(800).trim();
    expect(Buffer.byteLength(body)).toBeGreaterThan(PUSH_SERVICE_MAX_BYTES);
    expect(await send(aSock, { channelId, body })).toMatchObject({ ok: true });

    expect(encrypted).toHaveLength(1);
    expect(encrypted[0].length).toBeLessThanOrEqual(PUSH_SERVICE_MAX_BYTES);
    const pushed = JSON.parse(sendMock.mock.calls[0][1]).body;
    expect(pushed.endsWith("…")).toBe(true);
    expect(pushed.isWellFormed()).toBe(true);
    expect(body.startsWith(pushed.slice(0, -1))).toBe(true);

    // Même extrait côté Expo, dont la limite est aussi de 4 Ko par message.
    const [expoMessage] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(expoMessage.body).toBe(pushed);
    expect(Buffer.byteLength(JSON.stringify(expoMessage))).toBeLessThan(PUSH_SERVICE_MAX_BYTES);
  });
});
