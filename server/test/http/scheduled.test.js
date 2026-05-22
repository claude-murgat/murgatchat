import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/index.js";
import { dispatchScheduledMessages } from "../../src/socket.js";
import { registerUser, authed } from "../helpers/api.js";
import { seedMessage } from "../helpers/seed.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

async function setup() {
  const owner = await registerUser(app);
  const member = await registerUser(app);
  const ch = (await authed(app, owner.token).post("/channels").send({ name: "planif" })).body.channel;
  await authed(app, owner.token).post(`/channels/${ch.id}/members`).send({ userIds: [member.user.id] });
  return { owner, member, channelId: ch.id };
}

const future = (ms) => new Date(Date.now() + ms);

describe("GET /channels/:id/scheduled", () => {
  it("lists only the caller's undelivered scheduled messages, ordered", async () => {
    const { owner, member, channelId } = await setup();
    await seedMessage({ channelId, authorId: owner.user.id, body: "dans 2h", delivered: false, scheduledAt: future(7200000) });
    await seedMessage({ channelId, authorId: owner.user.id, body: "dans 1h", delivered: false, scheduledAt: future(3600000) });
    await seedMessage({ channelId, authorId: owner.user.id, body: "déjà envoyé" }); // delivered
    await seedMessage({ channelId, authorId: member.user.id, body: "à moi", delivered: false, scheduledAt: future(3600000) });

    const res = await authed(app, owner.token).get(`/channels/${channelId}/scheduled`);
    expect(res.status).toBe(200);
    expect(res.body.scheduled.map((s) => s.body)).toEqual(["dans 1h", "dans 2h"]);
  });
});

describe("PATCH /channels/scheduled/:id", () => {
  it("updates body and/or scheduledAt", async () => {
    const { owner, channelId } = await setup();
    const s = await seedMessage({ channelId, authorId: owner.user.id, body: "v1", delivered: false, scheduledAt: future(3600000) });

    const editBody = await authed(app, owner.token).patch(`/channels/scheduled/${s.id}`).send({ body: "v2" });
    expect(editBody.status).toBe(200);
    expect(editBody.body.scheduled.body).toBe("v2");

    const editWhen = await authed(app, owner.token)
      .patch(`/channels/scheduled/${s.id}`)
      .send({ scheduledAt: future(99999999) });
    expect(editWhen.status).toBe(200);
  });

  it("rejects past dates, empty body, no-op, and non-author/unknown", async () => {
    const { owner, member, channelId } = await setup();
    const s = await seedMessage({ channelId, authorId: owner.user.id, body: "v1", delivered: false, scheduledAt: future(3600000) });

    expect(
      (await authed(app, owner.token).patch(`/channels/scheduled/${s.id}`).send({ scheduledAt: new Date(Date.now() - 1000) })).body.error
    ).toBe("scheduled_at_must_be_future");
    expect(
      (await authed(app, owner.token).patch(`/channels/scheduled/${s.id}`).send({ body: "   " })).body.error
    ).toBe("empty_body");
    expect(
      (await authed(app, owner.token).patch(`/channels/scheduled/${s.id}`).send({})).body.error
    ).toBe("nothing_to_update");
    expect(
      (await authed(app, member.token).patch(`/channels/scheduled/${s.id}`).send({ body: "x" })).status
    ).toBe(404);
    expect(
      (await authed(app, owner.token).patch(`/channels/scheduled/missing`).send({ body: "x" })).status
    ).toBe(404);
  });
});

describe("DELETE /channels/scheduled/:id", () => {
  it("deletes the caller's scheduled message; rejects others with 404", async () => {
    const { owner, member, channelId } = await setup();
    const s = await seedMessage({ channelId, authorId: owner.user.id, body: "à supprimer", delivered: false, scheduledAt: future(3600000) });

    expect((await authed(app, member.token).delete(`/channels/scheduled/${s.id}`)).status).toBe(404);
    expect((await authed(app, owner.token).delete(`/channels/scheduled/${s.id}`)).status).toBe(200);
    const after = await authed(app, owner.token).get(`/channels/${channelId}/scheduled`);
    expect(after.body.scheduled.find((x) => x.id === s.id)).toBeUndefined();
  });
});

describe("dispatchScheduledMessages", () => {
  it("delivers due messages and removes them from the scheduled list", async () => {
    const { owner, channelId } = await setup();
    const due = await seedMessage({
      channelId, authorId: owner.user.id, body: "due now",
      delivered: false, scheduledAt: new Date(Date.now() - 1000),
    });

    await dispatchScheduledMessages(io);

    const msgs = await authed(app, owner.token).get(`/channels/${channelId}/messages`);
    expect(msgs.body.messages.some((m) => m.id === due.id && m.body === "due now")).toBe(true);
    const scheduled = await authed(app, owner.token).get(`/channels/${channelId}/scheduled`);
    expect(scheduled.body.scheduled.find((x) => x.id === due.id)).toBeUndefined();
  });
});
