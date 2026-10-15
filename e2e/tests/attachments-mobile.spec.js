import { test, expect } from "@playwright/test";

// Pièces jointes sur mobile étroit (360×705) : ni une image plus large que
// l'écran ni un nom de fichier très long ne doivent faire déborder le fil de
// messages, et le bouton « Télécharger », posé en overlay SUR la vignette ou la
// carte, doit rester visible et cliquable dans l'écran.
//
// `bypassCSP` : le stack e2e sert l'API en http://localhost:4001, que la CSP de
// nginx (`img-src … https:`) refuse pour les images — en production l'API est en
// https. Sans ce contournement, aucune vignette ne se chargerait et l'on ne
// testerait que le rendu d'une image cassée.
test.use({ viewport: { width: 360, height: 705 }, bypassCSP: true });

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
const tag = () => `att_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

// Virgin DB before each attempt (POST /test/reset gated par E2E_TEST_MODE ; un
// 404 — stack sans cette option — est toléré).
test.beforeEach(async ({ request }) => {
  const res = await request.post(`${API_URL.replace("localhost", "127.0.0.1")}/test/reset`);
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`/test/reset failed: HTTP ${res.status()}`);
  }
});

// Premier compte (DB vierge) : le serveur le bootstrap en admin ; sur mobile
// l'app ouvre alors directement #Général en plein écran.
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
  // Bandeau d'installation PWA : on le masque pour dégager le fil.
  const hideBanner = page.getByRole("button", { name: "Masquer" });
  if (await hideBanner.count()) await hideBanner.click();
}

// PNG réel généré par le navigateur (canvas), pour que la vignette ait de vraies
// dimensions naturelles.
async function pngOf(page, width, height) {
  const b64 = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#3f0e40";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#bcabbc";
      ctx.fillRect(0, h / 3, w, h / 3);
      return c.toDataURL("image/png").split(",")[1];
    },
    [width, height]
  );
  return Buffer.from(b64, "base64");
}

const messageRow = (page, text) =>
  page.locator("div.group").filter({ hasText: text }).last();

async function send(page, file, text) {
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText(file.name)).toBeVisible();
  const composer = page.getByPlaceholder(/^Message dans/);
  await composer.fill(text);
  await composer.press("Enter");
  return messageRow(page, text);
}

// `inner` est entièrement contenu dans `outer` (tolérance d'un pixel d'arrondi).
function expectInside(inner, outer) {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - 1);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - 1);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + 1);
}

test("pièces jointes sur mobile : pas de débordement, téléchargement en overlay visible", async ({
  page,
}, testInfo) => {
  await bootstrapAdmin(page);
  const viewport = { x: 0, y: 0, width: 360, height: 705 };

  // 1) Image très large (1600×600) : la vignette tient dans la colonne du message.
  const wideRow = await send(
    page,
    { name: "panorama.png", mimeType: "image/png", buffer: await pngOf(page, 1600, 600) },
    "image large mobile"
  );
  const thumb = wideRow.getByRole("img", { name: "panorama.png" });
  await expect(thumb).toBeVisible();
  await expect.poll(() => thumb.evaluate((img) => img.complete && img.naturalWidth)).toBe(1600);
  const thumbBox = await thumb.boundingBox();
  expectInside(thumbBox, viewport);
  const thumbDl = wideRow.getByRole("button", { name: "Télécharger panorama.png" });
  await expect(thumbDl).toBeVisible();
  const thumbDlBox = await thumbDl.boundingBox();
  // Bouton posé SUR la vignette, assez grand pour le doigt.
  expectInside(thumbDlBox, thumbBox);
  expect(thumbDlBox.width).toBeGreaterThanOrEqual(32);

  // 2) Petite image (40×40) : jamais agrandie, son bouton reste dans la vignette.
  const smallRow = await send(
    page,
    { name: "icone.png", mimeType: "image/png", buffer: await pngOf(page, 40, 40) },
    "petite image mobile"
  );
  const small = smallRow.getByRole("img", { name: "icone.png" });
  await expect.poll(() => small.evaluate((img) => img.complete && img.naturalWidth)).toBe(40);
  const smallBox = await small.boundingBox();
  const smallDlBox = await smallRow
    .getByRole("button", { name: "Télécharger icone.png" })
    .boundingBox();
  expectInside(smallDlBox, smallBox);

  // 3) Document au nom très long : carte pleine largeur, nom tronqué, bouton en
  //    overlay dans la carte sans recouvrir le nom.
  const longName =
    "proces-verbal-de-reception-des-travaux-batiment-b-lot-electricite-version-finale-2026.pdf";
  const docRow = await send(
    page,
    { name: longName, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") },
    "document long mobile"
  );
  const card = docRow.getByRole("button", { name: /^📕/ });
  const cardBox = await card.boundingBox();
  expectInside(cardBox, viewport);
  const docDl = docRow.getByRole("button", { name: `Télécharger ${longName}` });
  await expect(docDl).toBeVisible();
  const docDlBox = await docDl.boundingBox();
  expectInside(docDlBox, cardBox);
  const labelBox = await card.locator(".truncate").first().boundingBox();
  expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(docDlBox.x);

  // 4) Aucun défilement horizontal, ni du fil ni de la page.
  const overflow = await thumb.evaluate((img) => {
    const scroller = img.closest(".overflow-y-auto");
    return {
      list: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
      page: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(overflow.list).toBeLessThanOrEqual(0);
  expect(overflow.page).toBeLessThanOrEqual(0);

  // Le bouton en overlay télécharge bien le fichier, sans ouvrir l'aperçu.
  const downloadPromise = page.waitForEvent("download");
  await docDl.click();
  expect((await downloadPromise).suggestedFilename()).toBe(longName);
  await expect(page.getByRole("button", { name: "Fermer" })).toBeHidden();

  await testInfo.attach("pieces-jointes-360", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
