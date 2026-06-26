import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { createServer } from "../../src/index.js";
import { registerUser, authed } from "../helpers/api.js";
import { prisma } from "../helpers/db.js";

let app, io;
beforeAll(() => {
  ({ app, io } = createServer());
});
afterAll(() => {
  io.close();
});

// Poll until `fn` returns a truthy value (the GitHub mirror runs out-of-band,
// after the 201 response).
async function waitFor(fn, { tries = 50, delay = 10 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, delay));
  }
  return null;
}

describe("POST /bug-reports", () => {
  it("any authenticated user can file a report; it is stored", async () => {
    await registerUser(app); // owner
    const member = await registerUser(app);

    const res = await authed(app, member.token)
      .post("/bug-reports")
      .send({
        message: "Le bouton ne marche pas",
        logs: "12:00 [warn] socket disconnect\n12:01 [error] boom",
        diagnostics: { appVersion: "0.5.6", platform: "pwa" },
        appVersion: "0.5.6",
        platform: "pwa",
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();

    const row = await prisma.bugReport.findUnique({ where: { id: res.body.id } });
    expect(row.message).toBe("Le bouton ne marche pas");
    expect(row.userId).toBe(member.user.id);
    expect(row.status).toBe("open");
    expect(row.platform).toBe("pwa");
    expect(row.diagnostics).toEqual({ appVersion: "0.5.6", platform: "pwa" });
  });

  it("rejects an empty / whitespace-only message (400)", async () => {
    const owner = await registerUser(app);
    const res = await authed(app, owner.token).post("/bug-reports").send({ message: "   " });
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated callers (401)", async () => {
    await registerUser(app);
    const res = await request(app).post("/bug-reports").send({ message: "hi" });
    expect(res.status).toBe(401);
  });

  it("rejects oversized logs (400)", async () => {
    const owner = await registerUser(app);
    const huge = "x".repeat(100_001);
    const res = await authed(app, owner.token)
      .post("/bug-reports")
      .send({ message: "ok", logs: huge });
    expect(res.status).toBe(400);
  });

  it("truncates oversized diagnostics rather than failing", async () => {
    const owner = await registerUser(app);
    const bigDiag = { blob: "y".repeat(20_001) };
    const res = await authed(app, owner.token)
      .post("/bug-reports")
      .send({ message: "ok", diagnostics: bigDiag });
    expect(res.status).toBe(201);
    const row = await prisma.bugReport.findUnique({ where: { id: res.body.id } });
    expect(row.diagnostics).toEqual({ truncated: true });
  });
});

describe("POST /bug-reports → GitHub bridge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.GITHUB_BUG_TOKEN;
  });

  it("mirrors a new report to a GitHub issue and stores the link", async () => {
    process.env.GITHUB_BUG_TOKEN = "tok";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ number: 7, html_url: "https://github.com/x/y/issues/7" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const owner = await registerUser(app); // owner = admin
    const res = await authed(app, owner.token)
      .post("/bug-reports")
      .send({ message: "boom", logs: "ligne de log" });
    expect(res.status).toBe(201);

    const linked = await waitFor(async () => {
      const row = await prisma.bugReport.findUnique({ where: { id: res.body.id } });
      return row?.githubIssueNumber ? row : null;
    });
    expect(linked).not.toBeNull();
    expect(linked.githubIssueNumber).toBe(7);
    expect(linked.githubIssueUrl).toBe("https://github.com/x/y/issues/7");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The link surfaces through the admin serializer.
    const list = await authed(app, owner.token).get("/bug-reports");
    const found = list.body.reports.find((r) => r.id === res.body.id);
    expect(found.githubIssueUrl).toBe("https://github.com/x/y/issues/7");
  });

  it("still returns 201 when the GitHub bridge fails (best-effort)", async () => {
    process.env.GITHUB_BUG_TOKEN = "tok";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));

    const owner = await registerUser(app);
    const res = await authed(app, owner.token)
      .post("/bug-reports")
      .send({ message: "still ok" });
    expect(res.status).toBe(201);

    const row = await prisma.bugReport.findUnique({ where: { id: res.body.id } });
    expect(row.message).toBe("still ok");
    expect(row.githubIssueNumber).toBeNull();
  });

  it("does not call GitHub when the bridge is disabled (no token)", async () => {
    delete process.env.GITHUB_BUG_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const owner = await registerUser(app);
    const res = await authed(app, owner.token)
      .post("/bug-reports")
      .send({ message: "no bridge" });
    expect(res.status).toBe(201);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /bug-reports → attachments (issue #96)", () => {
  async function upload(token, name) {
    const up = await request(app)
      .post("/uploads")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("fake-png-bytes"), name);
    expect(up.status).toBe(200);
    return up.body.attachment.id;
  }

  it("links uploaded files to the report; admins can fetch them, others can't", async () => {
    const owner = await registerUser(app); // owner = admin
    const member = await registerUser(app);
    const other = await registerUser(app);

    const attId = await upload(member.token, "capture.png");
    const res = await authed(app, member.token)
      .post("/bug-reports")
      .send({ message: "voir la capture", attachmentIds: [attId] });
    expect(res.status).toBe(201);

    // The attachment row is now bound to the report.
    const att = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(att.bugReportId).toBe(res.body.id);

    // …and surfaces through the admin serializer.
    const list = await authed(app, owner.token).get("/bug-reports");
    const found = list.body.reports.find((r) => r.id === res.body.id);
    expect(found.attachments).toHaveLength(1);
    expect(found.attachments[0].filename).toBe("capture.png");

    // An admin who is neither the uploader nor a channel member can still fetch it
    // (the team consults reports through the admin backlog).
    const okDl = await request(app).get(`/uploads/${attId}?token=${owner.token}`);
    expect(okDl.status).toBe(200);

    // A non-admin who isn't the uploader cannot.
    const noDl = await request(app).get(`/uploads/${attId}?token=${other.token}`);
    expect(noDl.status).toBe(403);
  });

  it("ignores attachment ids the caller doesn't own", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);

    // owner uploads; member tries to claim it on their own report.
    const attId = await upload(owner.token, "owners.png");
    const res = await authed(app, member.token)
      .post("/bug-reports")
      .send({ message: "tentative de vol", attachmentIds: [attId] });
    expect(res.status).toBe(201);

    const att = await prisma.attachment.findUnique({ where: { id: attId } });
    expect(att.bugReportId).toBeNull(); // not hijacked
  });

  it("cascades attachments away when the report is deleted", async () => {
    const owner = await registerUser(app); // admin
    const attId = await upload(owner.token, "shot.png");
    const res = await authed(app, owner.token)
      .post("/bug-reports")
      .send({ message: "à supprimer", attachmentIds: [attId] });
    expect(res.status).toBe(201);

    const del = await authed(app, owner.token).delete(`/bug-reports/${res.body.id}`);
    expect(del.status).toBe(200);
    expect(await prisma.attachment.findUnique({ where: { id: attId } })).toBeNull();
  });
});

describe("GET /bug-reports (admin)", () => {
  it("rejects non-admins (403) and lists newest-first for admins", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    await authed(app, member.token).post("/bug-reports").send({ message: "premier" });
    await authed(app, owner.token).post("/bug-reports").send({ message: "second" });

    expect((await authed(app, member.token).get("/bug-reports")).status).toBe(403);

    const res = await authed(app, owner.token).get("/bug-reports");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.openCount).toBe(2);
    expect(res.body.reports[0].message).toBe("second"); // newest first
    expect(res.body.reports[0].user.id).toBe(owner.user.id);
    // The author's password hash must never leak through the embedded user.
    expect(res.body.reports[0].user.passwordHash).toBeUndefined();
  });

  it("paginates with ?pageSize and filters by ?status", async () => {
    const owner = await registerUser(app);
    for (let i = 0; i < 3; i++) {
      await authed(app, owner.token).post("/bug-reports").send({ message: `r${i}` });
    }

    const page = await authed(app, owner.token).get("/bug-reports?pageSize=2");
    expect(page.body.reports).toHaveLength(2);
    expect(page.body.hasMore).toBe(true);

    const open = await authed(app, owner.token).get("/bug-reports?status=open");
    expect(open.body.total).toBe(3);
    const closed = await authed(app, owner.token).get("/bug-reports?status=closed");
    expect(closed.body.total).toBe(0);
  });
});

describe("PATCH / DELETE /bug-reports/:id (admin)", () => {
  it("marks a report resolved then deletes it; members can do neither", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const created = await authed(app, member.token)
      .post("/bug-reports")
      .send({ message: "boom" });
    const id = created.body.id;

    // Member is blocked on both triage endpoints.
    expect(
      (await authed(app, member.token).patch(`/bug-reports/${id}`).send({ status: "closed" }))
        .status
    ).toBe(403);
    expect((await authed(app, member.token).delete(`/bug-reports/${id}`)).status).toBe(403);

    const patched = await authed(app, owner.token)
      .patch(`/bug-reports/${id}`)
      .send({ status: "closed" });
    expect(patched.status).toBe(200);
    expect(patched.body.report.status).toBe("closed");

    // The "open" filter now excludes it.
    const open = await authed(app, owner.token).get("/bug-reports?status=open");
    expect(open.body.total).toBe(0);

    const del = await authed(app, owner.token).delete(`/bug-reports/${id}`);
    expect(del.status).toBe(200);
    expect(await prisma.bugReport.findUnique({ where: { id } })).toBeNull();
  });

  it("rejects an invalid status (400) and an unknown id (404)", async () => {
    const owner = await registerUser(app);
    const created = await authed(app, owner.token)
      .post("/bug-reports")
      .send({ message: "x" });

    const bad = await authed(app, owner.token)
      .patch(`/bug-reports/${created.body.id}`)
      .send({ status: "bogus" });
    expect(bad.status).toBe(400);

    expect(
      (await authed(app, owner.token).patch("/bug-reports/nope").send({ status: "closed" }))
        .status
    ).toBe(404);
    expect((await authed(app, owner.token).delete("/bug-reports/nope")).status).toBe(404);
  });

  it("keeps a report (unlinked) after its author is deleted", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const created = await authed(app, member.token)
      .post("/bug-reports")
      .send({ message: "survivor" });

    // Hard-delete the author row → onDelete: SetNull keeps the report, userId null.
    await prisma.user.delete({ where: { id: member.user.id } });

    const row = await prisma.bugReport.findUnique({ where: { id: created.body.id } });
    expect(row).not.toBeNull();
    expect(row.userId).toBeNull();

    const list = await authed(app, owner.token).get("/bug-reports");
    const found = list.body.reports.find((r) => r.id === created.body.id);
    expect(found.user).toBeNull();
  });
});
