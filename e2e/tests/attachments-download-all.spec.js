import { test, expect } from "@playwright/test";

// Issue #479 : quand un message comporte plusieurs pièces jointes, un bouton
// « Tout télécharger » doit permettre de les enregistrer toutes en une seule
// action (un téléchargement par fichier), au lieu de cliquer sur chaque bouton
// individuel. Le bouton ne doit PAS apparaître lorsqu'il n'y a qu'une pièce
// jointe (le bouton par fichier suffit alors).
//
// `bypassCSP` : le stack e2e sert l'API en http://localhost:4001, que la CSP de
// nginx (`img-src … https:`) refuse pour les vignettes — en production l'API est
// en https. Sans ce contournement les images ne se chargeraient pas (même raison
// que les autres specs de pièces jointes).
test.use({ bypassCSP: true });

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
const tag = () => `dla_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

test.beforeEach(async ({ request }) => {
  const res = await request.post(`${API_URL.replace("localhost", "127.0.0.1")}/test/reset`);
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`/test/reset failed: HTTP ${res.status()}`);
  }
});

async function bootstrapAdmin(page) {
  const t = tag();
  await page.goto("/");
  const server = page.getByPlaceholder(/Adresse du serveur/);
  await expect(server).toBeVisible();
  await server.fill(API_URL);
  await page.getByRole("button", { name: "Tester" }).click();
  await expect(page.getByText(/joignable/)).toBeVisible();
  const banner = page.getByRole("button", { name: "Créer le compte admin" });
  const inviteLink = page.getByRole("button", { name: /j'ai une invitation/i });
  if (await banner.count()) await banner.first().click();
  else await inviteLink.click();
  await expect(page.getByPlaceholder("Nom affiché")).toBeVisible();
  await page.getByPlaceholder("Nom affiché").fill(`Admin ${t}`);
  await page.getByPlaceholder("Nom d'utilisateur").fill(t);
  await page.getByPlaceholder("Email").fill(`${t}@e2e.local`);
  await page.getByPlaceholder("Mot de passe").fill("test1234");
  const submit = page.getByRole("button", { name: "Créer le compte admin", exact: true });
  if (await submit.count()) await submit.click();
  else await page.getByRole("button", { name: "S'inscrire", exact: true }).click();
  await expect(page.getByPlaceholder("Message dans #Général")).toBeVisible();
  const hideBanner = page.getByRole("button", { name: "Masquer" });
  if (await hideBanner.count()) await hideBanner.click();
}

const messageRow = (page, text) =>
  page.locator("div.group").filter({ hasText: text }).last();

// Petit document réel (quelques octets suffisent : seul le téléchargement nous
// intéresse ici, pas le rendu).
const doc = (name) => ({
  name,
  mimeType: "application/pdf",
  buffer: Buffer.from(`%PDF-1.4 ${name}`),
});

async function send(page, files, text) {
  await page.locator('input[type="file"]').setInputFiles(files);
  for (const f of files) {
    await expect(page.getByText(f.name)).toBeVisible();
  }
  const composer = page.getByPlaceholder(/^Message dans/);
  await composer.fill(text);
  await composer.press("Enter");
  return messageRow(page, text);
}

test("plusieurs pièces jointes : « Tout télécharger » enregistre tous les fichiers (#479)", async ({
  page,
}) => {
  await bootstrapAdmin(page);

  const files = [doc("rapport.pdf"), doc("annexe.pdf"), doc("budget.pdf")];
  const row = await send(page, files, "message multi pièces jointes");

  // Le bouton groupé apparaît et affiche le nombre de pièces jointes.
  const downloadAll = row.getByRole("button", { name: `Tout télécharger (${files.length})` });
  await expect(downloadAll).toBeVisible();

  // Un clic déclenche bien un téléchargement par fichier (les noms couvrent
  // exactement l'ensemble des pièces jointes, sans doublon ni oubli).
  const downloads = [];
  page.on("download", (d) => downloads.push(d));
  await downloadAll.click();
  await expect.poll(() => downloads.length, { timeout: 15_000 }).toBe(files.length);
  const names = downloads.map((d) => d.suggestedFilename()).sort();
  expect(names).toEqual(files.map((f) => f.name).sort());
});

test("une seule pièce jointe : pas de bouton « Tout télécharger » (#479)", async ({ page }) => {
  await bootstrapAdmin(page);

  const row = await send(page, [doc("seul.pdf")], "message une seule pièce jointe");

  // Le bouton par fichier reste présent…
  await expect(row.getByRole("button", { name: "Télécharger seul.pdf" })).toBeVisible();
  // …mais pas le bouton groupé, inutile pour une unique pièce jointe.
  await expect(row.getByRole("button", { name: /^Tout télécharger/ })).toHaveCount(0);
});
