// GitHub bridge: mirror an in-app bug report to a GitHub issue, already triaged.
//
// The in-app support conversation (server/src/anthropic.js) does the triage
// itself — structured body, severity and domain. Triage (domain + severity) is
// written INTO the issue body, not as labels: GitHub fires one `labeled` event
// per label set at creation, and each one spins up (then skips) a claude-fix run
// — so extra triage labels meant extra skipped Actions runs. The issue carries
// only the single gate label "à-valider". A developer reviews it and applies
// "claude:fix" to kick off claude-fix.yml. There is no longer a separate triage
// workflow.
//
// Best-effort and optional by design:
//   - When GITHUB_BUG_TOKEN is unset the bridge is a no-op (dev / tests).
//   - Any failure is logged and swallowed; it must NEVER break report submission.
// Native fetch only, matching push.js / routes/gifs.js — no Octokit dependency.

const API = "https://api.github.com";

// GitHub caps issue bodies at 65536 chars. Stay well under so the message +
// diagnostics + Markdown scaffolding always fit alongside the (≤100 KB) logs.
const MAX_BODY = 60_000;

// The ONLY label applied at creation: marks the issue triaged and pending the
// human gate. Kept to a single label on purpose (see header comment) so issue
// creation fires just one `labeled` event.
const GATE_LABEL = "à-valider";

// Human-readable triage, rendered in the body instead of as labels. Unknown or
// missing values are simply skipped (one-shot reports carry no triage).
const DOMAIN_NAMES = {
  server: "Serveur",
  web: "Web",
  mobile: "Mobile",
  desktop: "Desktop",
};
const SEVERITY_NAMES = {
  faible: "Faible",
  moyenne: "Moyenne",
  élevée: "Élevée",
};

// A `> Domaine : … · Sévérité : …` blockquote line for the body header, or "".
function triageLine({ domain, severity } = {}) {
  const parts = [];
  if (domain && DOMAIN_NAMES[domain]) parts.push(`Domaine : ${DOMAIN_NAMES[domain]}`);
  if (severity && SEVERITY_NAMES[severity]) parts.push(`Sévérité : ${SEVERITY_NAMES[severity]}`);
  return parts.length ? `> ${parts.join(" · ")}\n` : "";
}

// Read env lazily (inside helpers, not at module load) so tests can toggle the
// bridge per-case and the values track docker-compose overrides.
function token() {
  return process.env.GITHUB_BUG_TOKEN || "";
}
function owner() {
  return process.env.GITHUB_REPO_OWNER || "claude-murgat";
}
function repo() {
  return process.env.GITHUB_REPO_NAME || "murgatchat";
}

export function githubEnabled() {
  return Boolean(token());
}

function firstLine(s) {
  return String(s || "").split("\n")[0].trim();
}

// Neutralize GitHub @mentions in user-controlled text. A chat username (or any
// text a user typed) can collide with a real GitHub handle — rendered as markdown
// it would ping/notify that account. A zero-width space right after the @ keeps
// the text visually identical but breaks the mention link. (Logs already sit in a
// fenced code block, where mentions never render, so they don't need this.)
function noMentions(s) {
  return String(s ?? "").replace(/@(?=[a-z0-9_-])/gi, "@​");
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

// List the report's attachments. They live behind the authenticated /uploads
// route (encrypted at rest), so they can't be embedded as images in the issue —
// the body just inventories them and points to where the team can open them.
function attachmentsBlock(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  const rows = attachments
    .map((a) => `- ${noMentions(a.filename || "fichier")} (${noMentions(a.mimeType || "?")} · ${humanSize(a.size)})`)
    .join("\n");
  return (
    `\n\n### Pièces jointes (${attachments.length})\n\n${rows}` +
    `\n\n_Consultables dans le panneau d'administration de l'application._`
  );
}

function diagnosticsBlock(diag) {
  if (!diag || typeof diag !== "object") return "";
  const rows = Object.entries(diag)
    .map(
      ([k, v]) =>
        `| ${noMentions(k)} | ${noMentions(String(v).replace(/\|/g, "\\|").slice(0, 300))} |`
    )
    .join("\n");
  if (!rows) return "";
  return `\n\n### Diagnostic\n\n| Clé | Valeur |\n| --- | --- |\n${rows}`;
}

// Build the issue body, keeping the message + diagnostics intact and truncating
// the (potentially 100 KB) logs so the whole thing stays under GitHub's limit.
export function buildIssueBody(report) {
  const reporter = report.user?.username
    ? noMentions(report.user.username)
    : "un utilisateur";
  const header =
    `> Signalement remonté depuis l'application par ${reporter}.\n` +
    triageLine(report) +
    `> Plateforme : ${report.platform || "?"} · Version : ${report.appVersion || "?"} · ` +
    `Report ID : \`${report.id}\`\n\n` +
    `### Message\n\n${noMentions(report.message)}`;

  const fixed =
    header + attachmentsBlock(report.attachments) + diagnosticsBlock(report.diagnostics);

  if (!report.logs) return fixed.slice(0, MAX_BODY);

  const open = `\n\n<details>\n<summary>Logs (${report.logs.length} caractères)</summary>\n\n\`\`\`\n`;
  const close = `\n\`\`\`\n</details>`;
  const budget = MAX_BODY - fixed.length - open.length - close.length - 20;
  if (budget <= 0) return fixed.slice(0, MAX_BODY);

  let logs = report.logs;
  let note = "";
  if (logs.length > budget) {
    logs = logs.slice(0, budget);
    note = `\n… (logs tronqués)`;
  }
  return fixed + open + logs + note + close;
}

// Create a GitHub issue mirroring the report. Returns { number, url } on
// success, or null when disabled / on any error (logged, never thrown).
export async function createIssueFromBugReport(report) {
  if (!githubEnabled()) return null;
  // Prefer an explicit refined title (set by the support conversation); fall
  // back to the first line of the message for one-shot reports.
  const subject = firstLine(report.title) || firstLine(report.message) || "sans titre";
  const title = (`[Signalement] ` + subject).slice(0, 120);
  try {
    const res = await fetch(`${API}/repos/${owner()}/${repo()}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "murgatchat-bug-bridge",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title,
        body: buildIssueBody(report),
        labels: [GATE_LABEL],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[github] create issue failed: ${res.status} ${detail.slice(0, 300)}`);
      return null;
    }
    const data = await res.json();
    return { number: data.number, url: data.html_url };
  } catch (e) {
    console.error("[github] create issue error:", e.message);
    return null;
  }
}
