import nodemailer from "nodemailer";

// SMTP is configured via env. In dev/test we point at Mailpit (a mail-catcher).
// If SMTP_HOST is unset, emails are logged instead of sent (so the app still works).
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "1025", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || "Chat <no-reply@murgat-chat.local>";
// Web app URL used to build the invite link (invitee opens it with ?invite=<token>).
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");

let transporter = null;
if (SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
} else {
  console.warn("[mail] SMTP_HOST not set — invitation emails are logged, not sent.");
}

export function inviteLink(token) {
  return APP_URL ? `${APP_URL}/?invite=${encodeURIComponent(token)}` : null;
}

// Returns { sent, link }. Never throws on a send failure caller-side handling aside;
// the invitation row already exists, so the admin can still share the link/code.
export async function sendInvitationEmail({ to, token, inviterName }) {
  const link = inviteLink(token);
  const who = inviterName || "Un membre";
  const subject = "Invitation à rejoindre Chat";
  const text = [
    `${who} vous invite à rejoindre Chat.`,
    "",
    link ? `Lien d'inscription : ${link}` : null,
    `Code d'invitation : ${token}`,
    "",
    "Sur l'écran d'inscription, indiquez l'adresse du serveur puis collez ce code (ou ouvrez le lien).",
  ]
    .filter((l) => l !== null)
    .join("\n");
  const html =
    `<p>${who} vous invite à rejoindre <b>Chat</b>.</p>` +
    (link ? `<p><a href="${link}">Cliquez ici pour vous inscrire</a></p>` : "") +
    `<p>Ou utilisez ce code d'invitation : <code>${token}</code></p>`;

  if (!transporter) {
    console.log(`[mail] (no SMTP) invitation for ${to}: code=${token} link=${link}`);
    return { sent: false, link };
  }
  await transporter.sendMail({ from: MAIL_FROM, to, subject, text, html });
  return { sent: true, link };
}
