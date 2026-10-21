import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createECDH, randomBytes } from "node:crypto";
import webpush from "web-push";
import {
  startTestServer,
  connectSocket,
  waitForEvent,
  expectNoEvent,
  waitInRoom,
} from "../helpers/server.js";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";

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

// La présence a été retirée : un message concernant un membre est poussé vers
// TOUS ses appareils, qu'il soit en train de regarder l'app ou non. Seuls DnD,
// le niveau du salon, un compte désactivé et l'exclusion de l'auteur suppriment.
describe("push notifications (notifyMembers)", () => {
  it("pushes to a recipient who isn't in DnD", async () => {
    const fetchMock = mockExpo();
    const { author, channelId, pushToken } = await setup();
    const aSock = await ready(author.token, channelId);

    await send(aSock, { channelId, body: "tu es loin" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.map((m) => m.to)).toContain(pushToken);
    expect(body[0].body).toBe("tu es loin");
  });

  it("pushes to every device even when the recipient's web client is connected and active", async () => {
    const fetchMock = mockExpo();
    const { author, recipient, channelId, pushToken } = await setup();
    // Le destinataire est connecté et au premier plan : on pousse quand même
    // (notif sur tous ses appareils), en plus de l'affichage in-app.
    const rSock = await ready(recipient.token, channelId, "web");
    const aSock = await ready(author.token, channelId);

    const inApp = waitForEvent(rSock, "notification", (n) => n.channelId === channelId);
    await send(aSock, { channelId, body: "tu es là" });
    await inApp; // in-app notification still delivered

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.map((m) => m.to)).toContain(pushToken);
  });

  it("pushes to the recipient's web push subscription", async () => {
    const sendMock = mockWebPush();
    const { author, recipient, channelId } = await setup({ recipientToken: false });
    const endpoint = await subscribeWebPush(recipient.user.id);
    const aSock = await ready(author.token, channelId);

    await send(aSock, { channelId, body: "coucou PWA" });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].endpoint).toBe(endpoint);
    expect(JSON.parse(sendMock.mock.calls[0][1])).toMatchObject({
      body: "coucou PWA",
      channelId,
      tag: `channel:${channelId}`,
    });
  });

  it("pushes to both native and web devices of the same recipient", async () => {
    const fetchMock = mockExpo();
    const sendMock = mockWebPush();
    const { author, recipient, channelId, pushToken } = await setup();
    const endpoint = await subscribeWebPush(recipient.user.id);
    const aSock = await ready(author.token, channelId);

    await send(aSock, { channelId, body: "partout" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).map((m) => m.to)).toContain(pushToken);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].endpoint).toBe(endpoint);
  });

  it("sends neither notification nor push when the recipient is in DnD", async () => {
    const fetchMock = mockExpo();
    const { author, recipient, channelId } = await setup();
    await authed(srv.app, recipient.token).post("/auth/dnd").send({ minutes: 60 });
    const rSock = await ready(recipient.token, channelId, "web");
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

  it("skips push when the recipient has no device or web subscription", async () => {
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
    const rSock = await ready(recipient.token, channelId, "web");
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

// Android retient souvent un push jusqu'au déverrouillage : le service worker
// vérifie alors, via le jeton de lecture du push, que le message n'a pas été lu
// entre-temps sur un autre appareil (cf. shared/pushTriage.ts, web/src/sw.ts).
describe("état de lecture des Web Push (jeton + /auth/web-push/read-state)", () => {
  const readState = (token, tokens) =>
    authed(srv.app, token).post("/auth/web-push/read-state").send({ tokens });

  it("le push porte un jeton : non lu à l'envoi, lu dès que le destinataire lit ailleurs", async () => {
    const sendMock = mockWebPush();
    const { author, recipient, channelId } = await setup({ recipientToken: false });
    await subscribeWebPush(recipient.user.id);
    const aSock = await ready(author.token, channelId);

    await send(aSock, { channelId, body: "lu sur le PC" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const { readToken } = JSON.parse(sendMock.mock.calls[0][1]);
    expect(readToken).toEqual(expect.any(String));

    // Jeton inconnu ou falsifié : null (le service worker affiche alors).
    const before = await readState(author.token, [readToken, "falsifie.abc"]);
    expect(before.status).toBe(200);
    expect(before.body.read).toEqual([false, null]);

    // Le destinataire lit le salon depuis un autre appareil.
    const rSock = await ready(recipient.token, channelId, "web");
    rSock.emit("channel:read", { channelId });
    await expect
      .poll(async () => (await readState(author.token, [readToken])).body.read)
      .toEqual([true]);
  });

  it("chaque destinataire reçoit son propre jeton", async () => {
    const sendMock = mockWebPush();
    const { author, recipient, channelId } = await setup({ recipientToken: false });
    const other = await registerUser(srv.app);
    await authed(srv.app, author.token)
      .post(`/channels/${channelId}/members`)
      .send({ userIds: [other.user.id] });
    await subscribeWebPush(recipient.user.id);
    await subscribeWebPush(other.user.id);
    const aSock = await ready(author.token, channelId);

    await send(aSock, { channelId, body: "pour deux" });
    expect(sendMock).toHaveBeenCalledTimes(2);
    const tokens = sendMock.mock.calls.map((c) => JSON.parse(c[1]).readToken);
    expect(new Set(tokens).size).toBe(2);
    // L'un lit : seul SON jeton passe à « lu ».
    const rSock = await ready(recipient.token, channelId, "web");
    rSock.emit("channel:read", { channelId });
    const byEndpoint = Object.fromEntries(
      sendMock.mock.calls.map((c) => [c[0].endpoint, JSON.parse(c[1]).readToken])
    );
    const mine = byEndpoint[`https://fcm.googleapis.com/fcm/send/${recipient.user.id}`];
    const theirs = byEndpoint[`https://fcm.googleapis.com/fcm/send/${other.user.id}`];
    await expect
      .poll(async () => (await readState(author.token, [mine, theirs])).body.read)
      .toEqual([true, false]);
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
