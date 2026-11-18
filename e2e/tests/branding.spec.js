import { test, expect } from "@playwright/test";

// Logo de Murgat Chat : l'icône de l'onglet (SVG clair/sombre + .ico de secours),
// les icônes de la PWA (manifest, écran d'accueil iOS, badge) et le logo blanc à
// gauche de « Murgat Chat » dans la barre latérale.

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
const tag = () => `brand_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

test.beforeEach(async ({ request }) => {
  const res = await request.post(`${API_URL.replace("localhost", "127.0.0.1")}/test/reset`);
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`/test/reset failed: HTTP ${res.status()}`);
  }
});

// Largeur et hauteur d'un PNG (en-tête IHDR).
function pngSize(buf) {
  expect(buf.subarray(1, 4).toString("latin1")).toBe("PNG");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test("l'onglet affiche le logo Murgat Chat (SVG, et .ico 16, 32 et 48 px)", async ({ page, request }) => {
  await page.goto("/");
  // Le .ico (Safari, vieux navigateurs) et le SVG (Chrome, Edge, Firefox).
  const icons = page.locator('link[rel="icon"]');
  await expect(icons).toHaveCount(2);
  expect(await icons.evaluateAll((ls) => ls.map((l) => l.getAttribute("href")))).toEqual([
    "/favicon.ico",
    "/favicon.svg",
  ]);

  const res = await request.get("/favicon.ico");
  expect(res.ok()).toBe(true);
  const ico = await res.body();
  // En-tête ICO : réservé 0, type 1 (icône), 3 images de 16, 32 et 48 px.
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  expect(ico.readUInt16LE(4)).toBe(3);
  const sizes = [0, 1, 2].map((i) => ico[6 + i * 16]).sort((a, b) => a - b);
  expect(sizes).toEqual([16, 32, 48]);

  // Le SVG passe en blanc en mode sombre.
  const svg = await request.get("/favicon.svg");
  expect(svg.ok()).toBe(true);
  expect(svg.headers()["content-type"]).toContain("image/svg+xml");
  expect(await svg.text()).toContain("prefers-color-scheme:dark");
});

test("l'écran de connexion affiche le logo, plus le « # »", async ({ page }) => {
  await page.goto("/");
  const logo = page.locator('img[src^="data:image/svg+xml"]').first();
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
  const box = await logo.boundingBox();
  expect([box.width, box.height]).toEqual([36, 36]);
});

test("les icônes de la PWA existent à la bonne taille", async ({ page, request }) => {
  await page.goto("/");
  // Écran d'accueil iOS : 180 px.
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/icons/apple-touch-icon.png",
  );
  const apple = await request.get("/icons/apple-touch-icon.png");
  expect(apple.ok()).toBe(true);
  expect(pngSize(await apple.body())).toEqual([180, 180]);

  // Chaque icône du manifest est servie et a la taille qu'il annonce.
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
  for (const icon of manifest.icons) {
    const r = await request.get(icon.src);
    expect(r.ok(), icon.src).toBe(true);
    const [w, h] = icon.sizes.split("x").map(Number);
    expect(pngSize(await r.body()), icon.src).toEqual([w, h]);
  }

  // Badge des notifications Android (monochrome).
  const badge = await request.get("/icons/badge-72.png");
  expect(badge.ok()).toBe(true);
  expect(pngSize(await badge.body())).toEqual([72, 72]);
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
