import { test, expect } from "@playwright/test";

// Issue #410 : une photo jointe en pleine résolution (type iPhone, ~4000 px de
// large, ~4 Mo) doit être redimensionnée/compressée CÔTÉ CLIENT avant l'upload —
// sinon l'envoi, et donc l'apparition de l'aperçu dans le champ de rédaction, est
// très long sur mobile/PWA. On vérifie que l'image stockée (puis rendue dans le
// fil) ne dépasse plus 1600 px : preuve que le redimensionnement a bien eu lieu
// dans le navigateur avant l'envoi.
//
// `bypassCSP` : le stack e2e sert l'API en http://localhost:4001, que la CSP de
// nginx (`img-src … https:`) refuse — en production l'API est en https. Sans ce
// contournement la vignette ne se chargerait pas (même raison que les autres
// specs de pièces jointes).
test.use({ viewport: { width: 360, height: 705 }, bypassCSP: true });

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
const tag = () => `ic_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

// Borne de redimensionnement appliquée par web/src/imageCompress.ts.
const MAX_DIMENSION = 1600;

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

// JPEG réel généré par le navigateur, bruité pour peser lourd (comme une photo).
// Renvoie un dataURL que l'on convertira en fichier via setInputFiles.
async function jpegOf(page, width, height) {
  const b64 = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      const img = ctx.createImageData(w, h);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = Math.random() * 255;
        img.data[i + 1] = Math.random() * 255;
        img.data[i + 2] = Math.random() * 255;
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return c.toDataURL("image/jpeg", 0.95).split(",")[1];
    },
    [width, height]
  );
  return Buffer.from(b64, "base64");
}

const messageRow = (page, text) =>
  page.locator("div.group").filter({ hasText: text }).last();

test("photo pleine résolution : redimensionnée côté client avant l'envoi (#410)", async ({
  page,
}) => {
  await bootstrapAdmin(page);

  // Photo « iPhone » 4032×3024. Sans compression client, l'image serait stockée
  // et rendue en 4032 px de large ; avec le correctif, elle est bornée à 1600.
  const buffer = await jpegOf(page, 4032, 3024);
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer });

  // Le chip de pièce jointe n'apparaît qu'une fois l'upload terminé : s'il arrive,
  // c'est que la compression puis l'upload ont abouti.
  await expect(page.getByText("photo.jpg")).toBeVisible();

  const composer = page.getByPlaceholder(/^Message dans/);
  await composer.fill("photo compressée");
  await composer.press("Enter");

  const thumb = messageRow(page, "photo compressée").getByRole("img", { name: "photo.jpg" });
  await expect(thumb).toBeVisible();
  // On attend que la vignette soit réellement décodée (dimensions naturelles > 0).
  await expect
    .poll(() => thumb.evaluate((img) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);
  const dims = await thumb.evaluate((img) => ({
    w: img.naturalWidth,
    h: img.naturalHeight,
  }));
  // L'image réellement stockée tient dans la borne de redimensionnement : la plus
  // grande dimension ne dépasse plus MAX_DIMENSION. Rapport d'aspect 4:3 préservé
  // (4032×3024 → 1600×1200), à un pixel d'arrondi près.
  expect(Math.max(dims.w, dims.h)).toBeLessThanOrEqual(MAX_DIMENSION);
  expect(dims.w).toBe(1600);
  expect(Math.abs(dims.h - 1200)).toBeLessThanOrEqual(1);
});
