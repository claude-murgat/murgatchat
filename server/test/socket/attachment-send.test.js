import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { startTestServer, connectSocket, waitInRoom } from "../helpers/server.js";
import { registerUser, authed } from "../helpers/api.js";

let srv;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});

const open = [];
afterEach(() => {
  for (const s of open) s.disconnect();
  open.length = 0;
});

const send = (socket, payload) =>
  new Promise((resolve) => socket.emit("message:send", payload, resolve));

async function aliceInChannel() {
  const alice = await registerUser(srv.app);
  const ch = (await authed(srv.app, alice.token).post("/channels").send({ name: "gif" }))
    .body.channel;
  const s = open[open.push(await connectSocket(srv.url, alice.token)) - 1];
  await waitInRoom(srv.io, ch.id, s.id);
  return { alice, channelId: ch.id, socket: s };
}

describe("message:send with attachments + empty body (the GIF case)", () => {
  it("accepts an attachment-only message (no text)", async () => {
    const { alice, channelId, socket } = await aliceInChannel();
    // Upload a file → encrypted attachment, exactly the shape /gifs/import produces.
    const up = await request(srv.app)
      .post("/uploads")
      .set("Authorization", `Bearer ${alice.token}`)
      .attach("file", Buffer.from("GIF89a" + "x".repeat(32)), "giphy.gif");
    expect(up.status).toBe(200);

    const ack = await send(socket, {
      channelId,
      body: "",
      attachmentIds: [up.body.attachment.id],
    });
    expect(ack.ok).toBe(true);
    expect(ack.message.attachments).toHaveLength(1);
    expect(ack.message.body).toBe("");
  });

  // Regression: the GIF composer briefly sent `[undefined]` (it read `att.id`
  // instead of `att.attachment.id`), and Prisma throws on a non-string in a
  // `where id in […]` filter → the handler 500'd with "server_error". The handler
  // now sanitizes ids, so a bad id can never crash the send.
  it("does not 500 on a garbage attachment id — returns a clean error instead", async () => {
    const { channelId, socket } = await aliceInChannel();

    // body empty + only a bogus id → nothing real to send → invalid_payload.
    const empty = await send(socket, { channelId, body: "", attachmentIds: [undefined] });
    expect(empty.error).toBe("invalid_payload");

    // body present + bogus id → the junk id is dropped, the text still sends.
    const withText = await send(socket, {
      channelId,
      body: "coucou",
      attachmentIds: [undefined, null, ""],
    });
    expect(withText.ok).toBe(true);
    expect(withText.message.body).toBe("coucou");
    expect(withText.message.attachments).toHaveLength(0);
  });
});
