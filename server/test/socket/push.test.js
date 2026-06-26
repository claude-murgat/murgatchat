import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { startTestServer, connectSocket, waitForEvent, expectNoEvent, waitInRoom } from "../helpers/server.js";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";

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
  vi.unstubAllGlobals();
});

// Mock the Expo push endpoint (push.js uses global fetch) so gating is testable
// offline and deterministic. `data` is the tickets array Expo would return.
function mockExpo(data = [{ status: "ok", id: "ticket-1" }]) {
  const fetchMock = vi.fn(async () => ({ json: async () => ({ data }) }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function ready(token, channelId, platform = "web") {
  const s = track(await connectSocket(srv.url, token, platform));
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
    const aSock = await ready(author.token, channelId);

    const inApp = waitForEvent(rSock, "notification", (n) => n.channelId === channelId);
    await send(aSock, { channelId, body: "tu es là" });
    await inApp; // in-app notification still delivered

    expect(fetchMock).not.toHaveBeenCalled(); // but no mobile push
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
    const fetchMock = mockExpo();
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
