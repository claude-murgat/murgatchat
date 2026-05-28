import { TEST_MAILPIT_API } from "../testEnv.js";

// Poll Mailpit for the latest email addressed to `toEmail` (optionally filtered
// by a substring in the subject). Returns {subject,text,html} or null on timeout.
export async function findEmail(toEmail, { timeout = 6000, subjectIncludes } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const search = `${TEST_MAILPIT_API}/api/v1/search?query=${encodeURIComponent("to:" + toEmail)}`;
    const res = await fetch(search).catch(() => null);
    if (res?.ok) {
      const data = await res.json();
      const candidates = (data.messages || []).filter(
        (m) => !subjectIncludes || (m.Subject || "").includes(subjectIncludes)
      );
      if (candidates.length) {
        const id = candidates[0].ID;
        const full = await (await fetch(`${TEST_MAILPIT_API}/api/v1/message/${id}`)).json();
        return { subject: full.Subject || "", text: full.Text || "", html: full.HTML || "" };
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

// Back-compat shim used by older tests.
export function findInvitationEmail(to, opts) {
  return findEmail(to, opts);
}

export async function clearMail() {
  await fetch(`${TEST_MAILPIT_API}/api/v1/messages`, { method: "DELETE" }).catch(() => {});
}
