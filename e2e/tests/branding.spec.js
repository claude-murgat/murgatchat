import { test, expect } from "@playwright/test";

// Logo de Murgat Chat : l'icône de l'onglet (favicon.ico, un rendu par taille)
// et le logo blanc à gauche de « Murgat Chat » dans la barre latérale.

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
const tag = () => `brand_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

test.beforeEach(async ({ request }) => {
  const res = await request.post(`${API_URL.replace("localhost", "127.0.0.1")}/test/reset`);
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`/test/reset failed: HTTP ${res.status()}`);
  }
});

test("l'onglet affiche le logo Murgat Chat (16, 32 et 48 px)", async ({ page, request }) => {
  await page.goto("/");
  // Une seule icône déclarée : le .ico, plus le « # » d'avant.
  const icons = page.locator('link[rel="icon"]');
  await expect(icons).toHaveCount(1);
  await expect(icons).toHaveAttribute("href", "/favicon.ico");

  const res = await request.get("/favicon.ico");
  expect(res.ok()).toBe(true);
  const ico = await res.body();
  // En-tête ICO : réservé 0, type 1 (icône), 3 images de 16, 32 et 48 px.
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  expect(ico.readUInt16LE(4)).toBe(3);
  const sizes = [0, 1, 2].map((i) => ico[6 + i * 16]).sort((a, b) => a - b);
  expect(sizes).toEqual([16, 32, 48]);
});

test("le logo blanc est à gauche de « Murgat Chat »", async ({ page }) => {
  const t = tag();
  await page.goto("/");
  await page.getByPlaceholder(/Adresse du serveur/).fill(API_URL);
  await page.getByRole("button", { name: "Tester" }).click();
  await expect(page.getByText(/joignable/)).toBeVisible();
  const banner = page.getByRole("button", { name: "Créer le compte admin" });
  if (await banner.count()) await banner.first().click();
  else await page.getByRole("button", { name: /j'ai une invitation/i }).click();
  await page.getByPlaceholder("Nom affiché").fill(`Admin ${t}`);
  await page.getByPlaceholder("Nom d'utilisateur").fill(t);
  await page.getByPlaceholder("Email").fill(`${t}@e2e.local`);
  await page.getByPlaceholder("Mot de passe").fill("test1234");
  const submit = page.getByRole("button", { name: "Créer le compte admin", exact: true });
  if (await submit.count()) await submit.click();
  else await page.getByRole("button", { name: "S'inscrire", exact: true }).click();

  const title = page.getByText("Murgat Chat", { exact: true });
  await expect(title).toBeVisible();
  const logo = page.locator("aside img").first();
  await expect(logo).toBeVisible();
  // Image chargée (intégrée au bundle), 40 px, à gauche du titre et centrée sur l'en-tête.
  expect(await logo.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
  const box = await logo.boundingBox();
  const titleBox = await title.boundingBox();
  expect(box.width).toBe(40);
  expect(box.height).toBe(40);
  expect(box.x + box.width).toBeLessThanOrEqual(titleBox.x);
});
