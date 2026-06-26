import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../auth.js";
import { githubEnabled, createIssueFromBugReport } from "../github.js";

const router = Router();

// Local admin gate — mirrors the one in routes/auth.js. Duplicated (one-liner on
// the already-loaded req.user) rather than shared, to keep the two routers
// decoupled.
function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: "admin_required" });
  next();
}

// Hard caps so a buggy or hostile client can't bloat a row. The client already
// trims its own buffer; these are the server-side backstop.
const MAX_MESSAGE = 5000;
const MAX_LOGS = 100_000; // ~100 KB of captured client logs
const MAX_DIAG = 20_000; // serialized JSON length

const createSchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE),
  logs: z.string().max(MAX_LOGS).optional(),
  diagnostics: z.any().optional(),
  appVersion: z.string().max(40).optional(),
  platform: z.string().max(40).optional(),
});

function serialize(r) {
  return {
    id: r.id,
    message: r.message,
    diagnostics: r.diagnostics ?? null,
    logs: r.logs ?? null,
    appVersion: r.appVersion ?? null,
    platform: r.platform ?? null,
    status: r.status,
    githubIssueNumber: r.githubIssueNumber ?? null,
    githubIssueUrl: r.githubIssueUrl ?? null,
    createdAt: r.createdAt,
    user: r.user
      ? {
          id: r.user.id,
          username: r.user.username,
          displayName: r.user.displayName,
          avatarColor: r.user.avatarColor,
        }
      : null,
  };
}

const userSelect = {
  select: { id: true, username: true, displayName: true, avatarColor: true },
};

// Any authenticated user can file a report.
router.post("/", requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_report" });
  const { message, logs, diagnostics, appVersion, platform } = parsed.data;

  // Bound the JSON column too — zod's .any() doesn't constrain its size.
  let diag = diagnostics ?? null;
  try {
    if (diag && JSON.stringify(diag).length > MAX_DIAG) diag = { truncated: true };
  } catch {
    diag = null; // non-serializable payload → drop it rather than 500
  }

  const data = {
    userId: req.userId,
    message,
    logs: logs || null,
    appVersion: appVersion || null,
    platform: platform || null,
  };
  // Only set the nullable Json column when we actually have a value: writing a
  // plain `null` to a Json? field is a Prisma runtime error (needs DbNull/JsonNull).
  if (diag != null) data.diagnostics = diag;

  const report = await prisma.bugReport.create({ data });
  res.status(201).json({ id: report.id });

  // Mirror to GitHub out-of-band: respond fast and never let GitHub's
  // availability affect submission. One-shot reports carry no triage; the issue
  // is created with NO label (the gate is implicit — open issue without
  // "claude:fix" awaits a human) and the link is stored back on the report for
  // admin traceability.
  if (githubEnabled()) {
    createIssueFromBugReport({
      ...report,
      user: req.user ? { username: req.user.username } : null,
    })
      .then((issue) =>
        issue
          ? prisma.bugReport.update({
              where: { id: report.id },
              data: { githubIssueNumber: issue.number, githubIssueUrl: issue.url },
            })
          : null
      )
      .catch((e) => console.error("[github] link update failed:", e.message));
  }
});

// Admin: paginated backlog, newest first, optional status filter.
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, parseInt(req.query.pageSize || "30", 10) || 30)
  );
  const status =
    req.query.status === "open" || req.query.status === "closed"
      ? req.query.status
      : undefined;
  const where = status ? { status } : {};

  const [total, openCount, rows] = await Promise.all([
    prisma.bugReport.count({ where }),
    prisma.bugReport.count({ where: { status: "open" } }),
    prisma.bugReport.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { user: userSelect },
    }),
  ]);

  res.json({
    reports: rows.map(serialize),
    total,
    openCount,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  });
});

const patchSchema = z.object({ status: z.enum(["open", "closed"]) });

// Admin: triage (mark resolved / reopen).
router.patch("/:id", requireAuth, requireAdmin, async (req, res) => {
  const parsed = patchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_status" });
  try {
    const r = await prisma.bugReport.update({
      where: { id: req.params.id },
      data: { status: parsed.data.status },
      include: { user: userSelect },
    });
    res.json({ report: serialize(r) });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

// Admin: delete a report once handled.
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    await prisma.bugReport.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

export default router;
