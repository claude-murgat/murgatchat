// GitHub bridge: mirror an in-app bug report to a GitHub issue, already triaged.
//
// The in-app support conversation (server/src/anthropic.js) does the triage
// itself — structured body, severity and domain — so the issue is created ready
// for the human gate (label "à-valider"). A developer reviews it and applies
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

// Applied on every created issue: marks it triaged and pending the human gate.
const GATE_LABEL = "à-valider";

// Map the conversation's classification onto the repo's existing labels. Unknown
// or missing values are simply skipped (one-shot reports carry no triage).
const DOMAIN_LABELS = {
  server: "domaine:server",
  web: "domaine:web",
  mobile: "domaine:mobile",
  desktop: "domaine:desktop",
};
const SEVERITY_LABELS = {
  faible: "sévérité:faible",
  moyenne: "sévérité:moyenne",
  élevée: "sévérité:élevée",
};

function issueLabels({ domain, severity } = {}) {
  const labels = [GATE_LABEL];
  if (domain && DOMAIN_LABELS[domain]) labels.push(DOMAIN_LABELS[domain]);
  if (severity && SEVERITY_LABELS[severity]) labels.push(SEVERITY_LABELS[severity]);
  return labels;
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

function diagnosticsBlock(diag) {
  if (!diag || typeof diag !== "object") return "";
  const rows = Object.entries(diag)
    .map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, "\\|").slice(0, 300)} |`)
    .join("\n");
  if (!rows) return "";
  return `\n\n### Diagnostic\n\n| Clé | Valeur |\n| --- | --- |\n${rows}`;
}

// Build the issue body, keeping the message + diagnostics intact and truncating
// the (potentially 100 KB) logs so the whole thing stays under GitHub's limit.
export function buildIssueBody(report) {
  const header =
    `> Signalement remonté depuis l'application par ` +
    (report.user?.username ? `@${report.user.username}` : "un utilisateur") +
    `.\n` +
    `> Plateforme : ${report.platform || "?"} · Version : ${report.appVersion || "?"} · ` +
    `Report ID : \`${report.id}\`\n\n` +
    `### Message\n\n${report.message}`;

  const fixed = header + diagnosticsBlock(report.diagnostics);

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
        labels: issueLabels({ domain: report.domain, severity: report.severity }),
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
