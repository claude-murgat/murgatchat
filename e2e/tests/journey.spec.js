import { test, expect } from "@playwright/test";

// Full web journey against a running stack: register, create a private channel
// (so we never clutter "Général"), send / edit / delete a message, reply in a
// thread, verify persistence across reload, then log out.
//
// Requires the web + server + db stack to be up (see TESTING.md). Each run uses
// a fresh user and its own channel, so it is self-contained.

const tag = () => `e2e_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

// Server address the client should talk to (configurable from the login screen).
const API_URL = process.env.E2E_API_URL || "http://localhost:4001";

async function register(page) {
  const t = tag();
  await page.goto("/");
  // Configure + test the server address (the new runtime-configurable field).
  const server = page.getByPlaceholder(/Adresse du serveur/);
  await expect(server).toBeVisible();
  await server.fill(API_URL);
  await page.getByRole("button", { name: "Tester" }).click();
  await expect(page.getByText(/joignable/)).toBeVisible();
  await page.getByRole("button", { name: "Pas encore de compte ? S'inscrire" }).click();
  await page.getByPlaceholder("Nom affiché").fill(`E2E ${t}`);
  await page.getByPlaceholder("Nom d'utilisateur").fill(t);
  await page.getByPlaceholder("Email").fill(`${t}@e2e.local`);
  await page.getByPlaceholder("Mot de passe").fill("test1234");
  await page.getByRole("button", { name: "S'inscrire", exact: true }).click();
  // Logged in: the default channel is visible in the sidebar.
  await expect(page.getByRole("button", { name: /Général/ })).toBeVisible();
  return t;
}

async function createPrivateChannel(page, name) {
  // The "+" button's accessible name is its text ("+"); target its title instead.
  await page.getByTitle("Ajouter — Salons").click();
  await expect(page.getByText("Créer une conversation")).toBeVisible();
  await page.getByPlaceholder("Nom du salon (ex. marketing)").fill(name);
  await page.getByText("Salon privé").click();
  await page.getByRole("button", { name: "Créer" }).click();
  await expect(page.getByText("Créer une conversation")).toBeHidden();
}

// The message row that contains `text` (Tailwind marks rows with class "group").
const messageRow = (page, text) =>
  page.locator("div.group").filter({ hasText: text }).last();

test("web journey: auth, channel, message lifecycle, threads, persistence", async ({ page }) => {
  page.on("dialog", (d) => d.accept()); // auto-accept the delete confirm

  await register(page);

  const channel = `e2e-${Date.now().toString(36)}`;
  await createPrivateChannel(page, channel);

  const composer = page.getByPlaceholder(`Message dans #${channel}`);
  await expect(composer).toBeVisible();

  // send
  await composer.fill("hello e2e");
  await composer.press("Enter");
  await expect(page.getByText("hello e2e")).toBeVisible();

  // edit
  const row = messageRow(page, "hello e2e");
  await row.hover();
  await row.getByRole("button", { name: "Modifier" }).click();
  // The edit textarea autofocuses; target it by focus (the row's text moves into
  // the textarea value, so a hasText row locator would go stale here).
  const editor = page.locator("textarea:focus");
  await editor.fill("hello edited");
  await editor.press("Enter");
  await expect(page.getByText("hello edited")).toBeVisible();
  await expect(page.getByText("(modifié)")).toBeVisible();

  // reply in a thread
  const editedRow = messageRow(page, "hello edited");
  await editedRow.hover();
  await editedRow.getByRole("button", { name: "Répondre" }).click();
  await expect(page.getByText("Fil de discussion")).toBeVisible();
  const reply = page.getByPlaceholder("Répondre…");
  await reply.fill("ma réponse");
  await reply.press("Enter");
  await expect(page.getByText("ma réponse")).toBeVisible();
  await expect(page.getByText(/1 réponse/)).toBeVisible();

  // delete a throwaway message
  await composer.fill("à supprimer");
  await composer.press("Enter");
  await expect(page.getByText("à supprimer")).toBeVisible();
  const delRow = messageRow(page, "à supprimer");
  await delRow.hover();
  await delRow.getByRole("button", { name: "Supprimer" }).click();
  await expect(page.getByText("à supprimer")).toHaveCount(0);

  // persistence across reload (token in localStorage + /auth/me bootstrap).
  // Reload lands on the first channel (Général), so re-open the e2e channel.
  await page.reload();
  await page.getByRole("button", { name: new RegExp(channel) }).click();
  await expect(page.getByText("hello edited")).toBeVisible();

  // logout
  await page.getByRole("button", { name: /E2E e2e_/ }).click();
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await expect(page.getByPlaceholder("email ou nom d'utilisateur")).toBeVisible();
});
