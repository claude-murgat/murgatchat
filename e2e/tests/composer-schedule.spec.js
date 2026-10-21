import { test, expect } from "@playwright/test";

// Régression #394 : sur la version web (bureau), le bouton de confirmation de
// planification et le bouton « Envoyer » étaient tous deux verts, de même
// style, et empilés à droite l'un au-dessus de l'autre — au point que des
// utilisateurs cliquaient « Envoyer » en croyant planifier, déclenchant un
// envoi immédiat irréversible. Les deux boutons doivent rester clairement
// distincts sur les trois axes signalés : libellé, couleur et position.
// Comme journey.spec.js, ce spec a besoin d'une stack e2e isolée (DB vierge).
test.use({ viewport: { width: 1280, height: 800 } });

const tag = () => `sched_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;
const API_URL = process.env.E2E_API_URL || "http://localhost:4001";

test.beforeEach(async ({ request }) => {
  // force IPv4 côté Node (Windows résout "localhost" en ::1, refusé).
  const res = await request.post(`${API_URL.replace("localhost", "127.0.0.1")}/test/reset`);
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`/test/reset failed: HTTP ${res.status()}`);
  }
});

async function configureServer(page) {
  const server = page.getByPlaceholder(/Adresse du serveur/);
  await expect(server).toBeVisible();
  await server.fill(API_URL);
  await page.getByRole("button", { name: "Tester" }).click();
  await expect(page.getByText(/joignable/)).toBeVisible();
}

// Premier compte (DB vierge) : pas de code -> le serveur le bootstrappe en admin.
async function bootstrapAdmin(page) {
  const t = tag();
  await page.goto("/");
  await configureServer(page);
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
  return t;
}

test("confirmation de planification distincte du bouton « Envoyer » (#394)", async ({
  page,
}) => {
  await bootstrapAdmin(page);

  const composer = page.getByPlaceholder("Message dans #Général");
  await composer.fill("message à planifier");

  const send = page.getByRole("button", { name: "Envoyer", exact: true });
  await expect(send).toBeEnabled();

  // Ouvre le panneau de planification via la bascule de la barre d'outils.
  await page.getByRole("button", { name: "Planifier un envoi" }).click();

  // Le bouton de confirmation porte un libellé propre, distinct de « Envoyer ».
  const confirm = page.getByRole("button", { name: "Planifier l'envoi" });
  await expect(confirm).toBeVisible();
  await expect(send).toBeVisible();

  // Couleur distincte : avant #394 les deux étaient verts (slackgreen). Le
  // bouton de planification doit désormais avoir une couleur de fond différente.
  const bg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg(confirm)).not.toBe(await bg(send));

  // Position distincte : le bouton de planification n'est plus empilé pile au-
  // dessus de « Envoyer » (aligné à droite) ; il reste à gauche, près du
  // sélecteur de date. Son bord droit est donc nettement à gauche du bouton
  // « Envoyer ».
  const cBox = await confirm.boundingBox();
  const sBox = await send.boundingBox();
  expect(cBox.x + cBox.width).toBeLessThan(sBox.x);
});
