import { test, expect } from "@playwright/test";

// Barre d'outils du composer sur très petit écran (320×640, petits mobiles /
// PWA) : 😀, pièce jointe, GIF, planification et « Envoyer » doivent tenir sur
// la largeur. Avant correctif, « Envoyer » sortait de l'écran par la droite —
// et sans barre de défilement, la colonne parente coupant ce qui dépasse.
test.use({ viewport: { width: 320, height: 640 } });

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
const tag = () => `cmp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

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
}

// `inner` est entièrement contenu dans `outer` (tolérance d'un pixel d'arrondi).
function expectInside(inner, outer) {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - 1);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - 1);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + 1);
}

test("composer à 320 px : la barre d'outils tient, « Envoyer » entièrement visible", async ({
  page,
}, testInfo) => {
  await bootstrapAdmin(page);
  const viewport = { x: 0, y: 0, width: 320, height: 640 };

  const composer = page.getByPlaceholder("Message dans #Général");
  await composer.fill("message depuis un écran de 320 px");

  const send = page.getByRole("button", { name: "Envoyer", exact: true });
  await expect(send).toBeEnabled();
  const toolbar = [
    page.getByTitle("Emoji"),
    page.getByTitle("Joindre un fichier"),
    page.getByTitle("Envoyer un GIF"),
    page.getByTitle("Planifier un envoi"),
    send,
  ];
  for (const button of toolbar) {
    await expect(button).toBeVisible();
    expectInside(await button.boundingBox(), viewport);
  }

  // Sous `sm`, les boutons pièce jointe / planification n'affichent que leur
  // icône : leur nom accessible (aria-label, doublé d'un title) reste explicite.
  const attach = page.getByRole("button", { name: "Joindre un fichier" });
  const schedule = page.getByRole("button", { name: "Planifier un envoi" });
  await expect(attach).toHaveAttribute("title", "Joindre un fichier");
  await expect(schedule).toHaveAttribute("title", "Planifier un envoi");
  await expect(attach.getByText("Fichier")).toBeHidden();
  await expect(schedule.getByText("Planifier")).toBeHidden();

  // Aucun défilement horizontal : ni la page, ni aucun ancêtre du bouton (la
  // colonne de l'app masque ce qui dépasse, d'où un bouton coupé sans scroll).
  const overflow = await send.evaluate((btn) => {
    const out = [];
    for (let el = btn.parentElement; el; el = el.parentElement) {
      const extra = el.scrollWidth - el.clientWidth;
      if (extra > 0) out.push(`${el.tagName.toLowerCase()}.${el.className} (+${extra}px)`);
    }
    return out;
  });
  expect(overflow).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  ).toBeLessThanOrEqual(0);

  await testInfo.attach("composer-320", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // Et le bouton reste utilisable : le message part.
  await send.click();
  await expect(composer).toHaveValue("");
  await expect(page.getByText("message depuis un écran de 320 px")).toBeVisible();
});
