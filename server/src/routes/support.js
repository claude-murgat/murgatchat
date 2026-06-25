import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../auth.js";
import { anthropicEnabled, runSupportTurn, MAX_TURNS } from "../anthropic.js";
import { githubEnabled, createIssueFromBugReport } from "../github.js";
import { notifyEnabled, tokenMatches, postPipelineMessage } from "../notify.js";
import { notifyMembers } from "../socket.js";

const router = Router();

// Same hard caps as routes/bugReports.js — the conversation feeds the same
// BugReport row and GitHub issue, so the limits must match.
const MAX_MESSAGE = 5000;
const MAX_LOGS = 100_000;
const MAX_DIAG = 20_000;

const startSchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE),
  logs: z.string().max(MAX_LOGS).optional(),
  diagnostics: z.any().optional(),
  appVersion: z.string().max(40).optional(),
  platform: z.string().max(40).optional(),
});

const turnSchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE),
});

// Bound the JSON column (zod's .any() doesn't), mirroring bugReports.js.
function boundDiagnostics(diagnostics) {
  let diag = diagnostics ?? null;
  try {
    if (diag && JSON.stringify(diag).length > MAX_DIAG) diag = { truncated: true };
  } catch {
    diag = null;
  }
  return diag;
}

// Expose just what the client needs to render the chat.
function serialize(c) {
  return {
    id: c.id,
    status: c.status,
    messages: Array.isArray(c.messages) ? c.messages : [],
    githubIssueNumber: c.githubIssueNumber ?? null,
    githubIssueUrl: c.githubIssueUrl ?? null,
  };
}

// Finalize a conversation: create the BugReport (refined body as message) and
// mirror it to GitHub as an already-triaged issue (labels carried from the
// conversation). Returns the issue link fields to store back on the conversation.
async function finalize(conv, finalizeInput, req) {
  const severity = finalizeInput.severity
    ? `**Sévérité estimée :** ${finalizeInput.severity}\n\n`
    : "";
  const message = (severity + (finalizeInput.body || "")).slice(0, MAX_MESSAGE);

  const data = {
    userId: conv.userId,
    message,
    logs: conv.logs || null,
    appVersion: conv.appVersion || null,
    platform: conv.platform || null,
  };
  if (conv.diagnostics != null) data.diagnostics = conv.diagnostics;

  const report = await prisma.bugReport.create({ data });

  let issue = null;
  if (githubEnabled()) {
    issue = await createIssueFromBugReport({
      ...report,
      title: finalizeInput.title,
      // The conversation already triaged the ticket: carry the classification
      // through. The issue gets only the gate label (à-valider); domain +
      // severity are written into the body (see github.js) — there is no
      // separate triage step.
      domain: finalizeInput.domain,
      severity: finalizeInput.severity,
      user: req.user ? { username: req.user.username } : null,
    });
    if (issue) {
      await prisma.bugReport.update({
        where: { id: report.id },
        data: { githubIssueNumber: issue.number, githubIssueUrl: issue.url },
      });
    }
  }

  return { bugReportId: report.id, issue };
}

// Start a support conversation. The diagnostics snapshot is captured here and
// carried through to the BugReport / issue on finalization.
router.post("/conversations", requireAuth, async (req, res) => {
  if (!anthropicEnabled()) {
    return res.status(503).json({ error: "support_chat_unavailable" });
  }
  const parsed = startSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_message" });
  const { message, logs, diagnostics, appVersion, platform } = parsed.data;

  // Bound the diagnostics up front so the very first model turn already gets the
  // environment (and Claude doesn't re-ask for it).
  const diag = boundDiagnostics(diagnostics);
  const base = {
    userId: req.userId,
    appVersion: appVersion || null,
    platform: platform || null,
    logs: logs || null,
  };
  if (diag != null) base.diagnostics = diag;

  const messages = [{ role: "user", content: message }];
  const turn = await runSupportTurn(messages, {
    appVersion: base.appVersion,
    platform: base.platform,
    diagnostics: diag,
    logs: base.logs,
  });
  if (!turn) return res.status(502).json({ error: "support_chat_error" });

  messages.push({ role: "assistant", content: turn.reply });

  // Create the row first so finalize() (which needs conv fields) has them.
  const conv = await prisma.supportConversation.create({
    data: { ...base, status: "open", messages },
  });

  if (turn.finalize) {
    const { bugReportId, issue } = await finalize(conv, turn.finalize, req);
    const updated = await prisma.supportConversation.update({
      where: { id: conv.id },
      data: {
        status: "submitted",
        bugReportId,
        githubIssueNumber: issue?.number ?? null,
        githubIssueUrl: issue?.url ?? null,
      },
    });
    return res.status(201).json({ ...serialize(updated), reply: turn.reply });
  }

  res.status(201).json({ ...serialize(conv), reply: turn.reply });
});

// Continue an existing conversation.
router.post("/conversations/:id/messages", requireAuth, async (req, res) => {
  const conv = await prisma.supportConversation.findUnique({
    where: { id: req.params.id },
  });
  if (!conv || conv.userId !== req.userId) {
    return res.status(404).json({ error: "not_found" });
  }
  if (conv.status !== "open") {
    return res.status(409).json({ error: "conversation_closed" });
  }
  if (!anthropicEnabled()) {
    return res.status(503).json({ error: "support_chat_unavailable" });
  }

  const parsed = turnSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_message" });

  const prior = Array.isArray(conv.messages) ? conv.messages : [];
  const userTurns = prior.filter((m) => m.role === "user").length;
  if (userTurns >= MAX_TURNS) {
    return res.status(409).json({ error: "too_many_turns" });
  }

  const messages = [...prior, { role: "user", content: parsed.data.message }];
  const turn = await runSupportTurn(messages, {
    appVersion: conv.appVersion,
    platform: conv.platform,
    diagnostics: conv.diagnostics,
    logs: conv.logs,
  });
  if (!turn) return res.status(502).json({ error: "support_chat_error" });

  messages.push({ role: "assistant", content: turn.reply });

  if (turn.finalize) {
    const { bugReportId, issue } = await finalize(conv, turn.finalize, req);
    const updated = await prisma.supportConversation.update({
      where: { id: conv.id },
      data: {
        status: "submitted",
        messages,
        bugReportId,
        githubIssueNumber: issue?.number ?? null,
        githubIssueUrl: issue?.url ?? null,
      },
    });
    return res.json({ ...serialize(updated), reply: turn.reply });
  }

  const updated = await prisma.supportConversation.update({
    where: { id: conv.id },
    data: { messages },
  });
  res.json({ ...serialize(updated), reply: turn.reply });
});

// Pipeline → chat notification. Called by the claude-fix workflow (machine to
// machine) when a PR is opened, so the team is pinged in-app. Auth is a shared
// secret (SUPPORT_NOTIFY_TOKEN), NOT a user JWT — hence no requireAuth.
const notifySchema = z.object({
  issueNumber: z.number().int().positive().optional(),
  prUrl: z.string().url().max(500),
  title: z.string().max(300).optional(),
});

router.post("/notify", async (req, res) => {
  if (!notifyEnabled()) return res.status(503).json({ error: "notify_disabled" });
  const auth = req.headers.authorization || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!tokenMatches(provided)) return res.status(401).json({ error: "unauthorized" });

  const parsed = notifySchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_payload" });
  const { issueNumber, prUrl, title } = parsed.data;

  const head = issueNumber ? `🤖 PR ouverte pour l'issue #${issueNumber}` : "🤖 PR ouverte";
  const text =
    `${head}${title ? ` — ${title}` : ""}\n${prUrl}\n\n` +
    `À relire, puis poser le label « revue-ia » sur la PR pour une revue IA automatique.`;

  try {
    const { channelId, authorId, serialized } = await postPipelineMessage(text);
    if (req.io) {
      req.io.to(`channel:${channelId}`).emit("message:new", serialized);
      await notifyMembers(req.io, channelId, authorId, serialized);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[notify] failed:", e.message);
    res.status(500).json({ error: "notify_failed" });
  }
});

export default router;
