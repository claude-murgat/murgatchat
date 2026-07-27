import nodemailer from "nodemailer";

// SMTP is configured entirely via env so the same image can target Mailpit in dev,
// Brevo / SendGrid / any provider in prod, or run "log-only" (SMTP_HOST empty).
// See .env.example for a Brevo example.
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "1025", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
// SMTP_SECURE: "true"/"1" => SSL (typically port 465). Auto-on for port 465.
// For STARTTLS (Brevo 587), leave it off and set SMTP_REQUIRE_TLS=true.
const SMTP_SECURE = parseBool(process.env.SMTP_SECURE, SMTP_PORT === 465);
const SMTP_REQUIRE_TLS = parseBool(process.env.SMTP_REQUIRE_TLS, false);
const MAIL_FROM = process.env.MAIL_FROM || "Chat <no-reply@murgat-chat.local>";
// Web app URL used to build invite/reset links (opens the app with ?invite=… or ?reset=…).
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");

function parseBool(v, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

let transporter = null;
if (SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    requireTLS: SMTP_REQUIRE_TLS,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
} else {
  console.warn("[mail] SMTP_HOST not set — invitation / reset emails are logged, not sent.");
}

export function inviteLink(token) {
  return APP_URL ? `${APP_URL}/?invite=${encodeURIComponent(token)}` : null;
}

export function resetLink(token) {
  return APP_URL ? `${APP_URL}/?reset=${encodeURIComponent(token)}` : null;
}

// Returns { sent, link }. The caller already has a row in DB so a send failure
// is non-fatal: the admin can still copy/paste the link/code from the UI.
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

  return sendMail({ to, subject, text, html, link });
}

export async function sendPasswordResetEmail({ to, token, displayName }) {
  const link = resetLink(token);
  const who = displayName || "Bonjour";
  const subject = "Réinitialisation de votre mot de passe";
  const text = [
    `${who},`,
    "",
    "Vous avez demandé à réinitialiser votre mot de passe Chat.",
    link ? `Lien de réinitialisation : ${link}` : null,
    `Code : ${token}`,
    "",
    "Le lien et le code expirent dans 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.",
  ]
    .filter((l) => l !== null)
    .join("\n");
  const html =
    `<p>${who},</p>` +
    `<p>Vous avez demandé à réinitialiser votre mot de passe <b>Chat</b>.</p>` +
    (link ? `<p><a href="${link}">Cliquez ici pour choisir un nouveau mot de passe</a></p>` : "") +
    `<p>Ou utilisez ce code : <code>${token}</code></p>` +
    `<p style="color:#666;font-size:12px">Le lien et le code expirent dans 1 heure. ` +
    `Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.</p>`;

  return sendMail({ to, subject, text, html, link });
}

async function sendMail({ to, subject, text, html, link }) {
  if (!transporter) {
    console.log(`[mail] (no SMTP) to=${to} subject="${subject}" link=${link}`);
    return { sent: false, link };
  }
  await transporter.sendMail({ from: MAIL_FROM, to, subject, text, html });
  return { sent: true, link };
}
