import { test, expect } from "@playwright/test";

// Onglet « Stockage » de l'administration : place libre du disque du serveur,
// fichiers du chat rangés par type du plus lourd au plus léger, et plus gros
// fichiers — sans le nom de ceux que l'admin n'a pas à voir.

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
// Requêtes côté Node : forcer IPv4 (voir session.spec.js).
const API = API_URL.replace("localhost", "127.0.0.1");

test.beforeEach(async ({ request }) => {
  const res = await request.post(`${API}/test/reset`);
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`/test/reset failed: HTTP ${res.status()}`);
  }
});

test("l'onglet Stockage montre la place libre et ce qu'occupent les fichiers du chat", async ({
  browser,
  request,
}) => {
  const t = `sto_${Date.now().toString(36)}`;
  const reg = await request.post(`${API}/auth/register`, {
    data: { email: `${t}@e2e.local`, username: t, displayName: "Patronne E2E", password: "test1234" },
  });
  expect(reg.ok()).toBeTruthy();
  const { token } = await reg.json();
  // Téléversée mais jamais postée : ni son nom ni son salon ne sont affichés.
  const draft = await request.post(`${API}/uploads`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: { file: { name: "brouillon.png", mimeType: "image/png", buffer: Buffer.alloc(100_000) } },
  });
  expect(draft.ok()).toBeTruthy();

  const context = await browser.newContext();
  await context.addInitScript(
    ([tok, base]) => {
      localStorage.setItem("chat_token", tok);
      localStorage.setItem("chat_api_base", base);
    },
    [token, API_URL]
  );
  const page = await context.newPage();
  await page.goto("/");
  const composer = page.getByPlaceholder("Message dans #Général");
  await expect(composer).toBeVisible();

  // Un PDF arrivé en octet-stream est rangé d'après son extension.
  await page.locator('input[type="file"]').setInputFiles({
    name: "devis.pdf",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(300_000),
  });
  await expect(page.getByText("devis.pdf")).toBeVisible();
  await composer.fill("le devis");
  await composer.press("Enter");
  await expect(page.getByText("le devis")).toBeVisible();

  await page.getByRole("button", { name: /Patronne E2E/ }).first().click();
  await page.getByRole("button", { name: "Administration" }).click();
  await page.getByRole("button", { name: "Stockage" }).click();

  await expect(page.getByText(/disponibles sur/)).toBeVisible();
  const section = (title) =>
    page.locator("section", { has: page.getByRole("heading", { name: title }) });
  const types = section("Fichiers du chat").locator("li");
  await expect(types).toHaveCount(2);
  await expect(types).toContainText(["Document PDF", "Image"]);
  await expect(types.first()).toContainText("293 ko");
  const largest = section("Plus gros fichiers").locator("li");
  await expect(largest).toContainText(["devis.pdf", "Fichier privé"]);
  await expect(largest).toContainText(["#Général", "Non envoyé"]);
});
