import { test, expect } from "@playwright/test";

// Full web journey with invitation-based registration. Requires a FRESH isolated
// stack (empty DB) so the first account bootstraps as admin. See TESTING.md.

const tag = () => `e2e_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;
const API_URL = process.env.E2E_API_URL || "http://localhost:4001";

async function configureServer(page) {
  const server = page.getByPlaceholder(/Adresse du serveur/);
  await expect(server).toBeVisible();
  await server.fill(API_URL);
  await page.getByRole("button", { name: "Tester" }).click();
  await expect(page.getByText(/joignable/)).toBeVisible();
}

// First account: no invitation code -> server bootstraps it as admin.
// With needsBootstrap UX, the login page shows a "Premier démarrage" banner
// with a "Créer le compte admin" CTA; clicking it switches to register mode
// (invitation-code field hidden, submit also labeled "Créer le compte admin").
async function bootstrapAdmin(page) {
  const t = tag();
  await page.goto("/");
  await configureServer(page);
  // CTA in the bootstrap banner. `.first()` because the submit button will
  // share the same name after the mode switch; here we want the banner one.
  await page.getByRole("button", { name: "Créer le compte admin" }).first().click();
  await expect(page.getByPlaceholder("Nom affiché")).toBeVisible();
  await page.getByPlaceholder("Nom affiché").fill(`Admin ${t}`);
  await page.getByPlaceholder("Nom d'utilisateur").fill(t);
  await page.getByPlaceholder("Email").fill(`${t}@e2e.local`);
  await page.getByPlaceholder("Mot de passe").fill("test1234");
  // Banner is hidden now (mode === register), so this resolves to the submit.
  await page.getByRole("button", { name: "Créer le compte admin", exact: true }).click();
  await expect(page.getByRole("button", { name: /Général/ })).toBeVisible();
  return t;
}

// Admin invites an email via the modal; returns the invitation code shown.
async function inviteViaModal(page, adminTag, email) {
  await page.getByRole("button", { name: new RegExp(`Admin ${adminTag}`) }).click();
  await page.getByRole("button", { name: "Inviter un utilisateur" }).click();
  await expect(page.getByText("Inviter un utilisateur")).toBeVisible();
  await page.getByPlaceholder("email@exemple.fr").fill(email);
  await page.getByRole("button", { name: "Inviter" }).click();
  const code = (await page.locator("span.font-mono").first().innerText()).trim();
  expect(code.length).toBeGreaterThan(10);
  await page.getByRole("button", { name: "Fermer" }).click();
  return code;
}

async function logout(page) {
  await page.getByRole("button", { name: /Admin / }).click();
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await expect(page.getByPlaceholder("email ou nom d'utilisateur")).toBeVisible();
}

// Register an invited user with the code (email is prefilled from the invitation).
async function registerWithCode(page, code, email) {
  const t = tag();
  await page.getByRole("button", { name: /s'inscrire/i }).click();
  await page.getByPlaceholder("Code d'invitation").fill(code);
  await expect(page.getByText(new RegExp(`Invitation valide pour ${email}`))).toBeVisible();
  await page.getByPlaceholder("Nom affiché").fill(`E2E ${t}`);
  await page.getByPlaceholder("Nom d'utilisateur").fill(t);
  await page.getByPlaceholder("Mot de passe").fill("test1234");
  await page.getByRole("button", { name: "S'inscrire", exact: true }).click();
  await expect(page.getByRole("button", { name: /Général/ })).toBeVisible();
  return t;
}

async function createPrivateChannel(page, name) {
  await page.getByTitle("Ajouter — Salons").click();
  await expect(page.getByText("Créer une conversation")).toBeVisible();
  await page.getByPlaceholder("Nom du salon (ex. marketing)").fill(name);
  await page.getByText("Salon privé").click();
  await page.getByRole("button", { name: "Créer" }).click();
  await expect(page.getByText("Créer une conversation")).toBeHidden();
}

const messageRow = (page, text) =>
  page.locator("div.group").filter({ hasText: text }).last();

test("invitation registration + full web journey", async ({ page }) => {
  page.on("dialog", (d) => d.accept());

  // Bootstrap admin, invite a user, capture the code, log out.
  const adminTag = await bootstrapAdmin(page);
  const inviteeEmail = `invitee_${Date.now().toString(36)}@e2e.local`;
  const code = await inviteViaModal(page, adminTag, inviteeEmail);
  await logout(page);

  // The invited user registers with the code (email prefilled).
  await registerWithCode(page, code, inviteeEmail);

  // Channel + message lifecycle as the invited user.
  const channel = `e2e-${Date.now().toString(36)}`;
  await createPrivateChannel(page, channel);

  const composer = page.getByPlaceholder(`Message dans #${channel}`);
  await composer.fill("hello e2e");
  await composer.press("Enter");
  await expect(page.getByText("hello e2e")).toBeVisible();

  const row = messageRow(page, "hello e2e");
  await row.hover();
  await row.getByRole("button", { name: "Modifier" }).click();
  const editor = page.locator("textarea:focus");
  await editor.fill("hello edited");
  await editor.press("Enter");
  await expect(page.getByText("hello edited")).toBeVisible();
  await expect(page.getByText("(modifié)")).toBeVisible();

  const editedRow = messageRow(page, "hello edited");
  await editedRow.hover();
  await editedRow.getByRole("button", { name: "Répondre" }).click();
  await expect(page.getByText("Fil de discussion")).toBeVisible();
  const reply = page.getByPlaceholder("Répondre…");
  await reply.fill("ma réponse");
  await reply.press("Enter");
  await expect(page.getByText("ma réponse")).toBeVisible();
  await expect(page.getByText(/1 réponse/)).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: new RegExp(channel) }).click();
  await expect(page.getByText("hello edited")).toBeVisible();
});
