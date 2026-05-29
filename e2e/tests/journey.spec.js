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
// We use the always-present "J'ai une invitation" switcher to reach the
// register form, then submit with an empty code field — the server treats
// that as the bootstrap path when the DB is empty. This avoids racing the
// async /health probe that toggles the needsBootstrap banner.
async function bootstrapAdmin(page) {
  const t = tag();
  await page.goto("/");
  await configureServer(page);
  // Two routes to the register form depending on whether the (async) /health
  // probe has flipped `needsBootstrap` yet — the bootstrap banner CTA or the
  // always-present "J'ai une invitation" switcher. Try both.
  const banner = page.getByRole("button", { name: "Créer le compte admin" });
  const inviteLink = page.getByRole("button", { name: /j'ai une invitation/i });
  if (await banner.count()) await banner.first().click();
  else await inviteLink.click();
  await expect(page.getByPlaceholder("Nom affiché")).toBeVisible();
  await page.getByPlaceholder("Nom affiché").fill(`Admin ${t}`);
  await page.getByPlaceholder("Nom d'utilisateur").fill(t);
  await page.getByPlaceholder("Email").fill(`${t}@e2e.local`);
  await page.getByPlaceholder("Mot de passe").fill("test1234");
  // Submit label depends on needsBootstrap: "Créer le compte admin" when set,
  // "S'inscrire" otherwise. The two are mutually exclusive in render.
  const submit = page.getByRole("button", { name: "Créer le compte admin", exact: true });
  if (await submit.count()) await submit.click();
  else await page.getByRole("button", { name: "S'inscrire", exact: true }).click();
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

  // Inline reply (Discord-style): clicking "Répondre" shows a quote banner
  // above the main composer, then the reply lands in the same timeline with
  // a clickable quote bubble of the parent.
  const editedRow = messageRow(page, "hello edited");
  await editedRow.hover();
  await editedRow.getByRole("button", { name: "Répondre" }).click();
  await expect(page.getByText("↩ Réponse à")).toBeVisible();
  await composer.fill("ma réponse");
  await composer.press("Enter");
  await expect(page.getByText("ma réponse")).toBeVisible();
  // The quote banner above the composer goes away once the reply is sent.
  await expect(page.getByText("↩ Réponse à")).toBeHidden();

  // Markdown rendering: a message with inline markdown renders real elements
  // (not literal asterisks/backticks).
  await composer.fill("du **gras** et du `code`");
  await composer.press("Enter");
  const mdRow = messageRow(page, "gras");
  await expect(mdRow.locator("strong", { hasText: "gras" })).toBeVisible();
  await expect(mdRow.locator("code", { hasText: "code" })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: new RegExp(channel) }).click();
  // After the reload there are 2 "hello edited" on screen: the original
  // message and the quote bubble inside our reply. .first() targets the
  // original (the topmost in the timeline).
  await expect(page.getByText("hello edited").first()).toBeVisible();
  // Markdown survives a reload (re-parsed from the stored source).
  await expect(messageRow(page, "gras").locator("strong")).toBeVisible();
});
