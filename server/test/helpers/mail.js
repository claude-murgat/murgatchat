import { TEST_MAILPIT_API } from "../testEnv.js";

// Poll Mailpit for the latest email addressed to `toEmail`. Returns the message
// (subject + text/html body) or null after the timeout.
export async function findInvitationEmail(toEmail, { timeout = 6000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const search = `${TEST_MAILPIT_API}/api/v1/search?query=${encodeURIComponent("to:" + toEmail)}`;
    const res = await fetch(search).catch(() => null);
    if (res?.ok) {
      const data = await res.json();
      if (data.messages?.length) {
        const id = data.messages[0].ID;
        const full = await (await fetch(`${TEST_MAILPIT_API}/api/v1/message/${id}`)).json();
        return { subject: full.Subject || "", text: full.Text || "", html: full.HTML || "" };
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

export async function clearMail() {
  await fetch(`${TEST_MAILPIT_API}/api/v1/messages`, { method: "DELETE" }).catch(() => {});
}
