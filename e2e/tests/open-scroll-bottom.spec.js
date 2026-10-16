import { test, expect } from "@playwright/test";

// Régression #389 — à l'ouverture, une conversation doit s'afficher sur son
// DERNIER message, même quand les vignettes d'images arrivent après le scroll
// initial.
//
// ChannelView reste monté et rend « Sélectionnez une conversation » tant
// qu'aucun salon n'est actif — c'est le cas au démarrage, le temps que la liste
// des salons arrive. Le re-calage en bas sur le chargement des images n'était
// posé qu'une fois, au montage : dans ce cas il ne s'attachait jamais, et chaque
// vignette (80 px avant chargement, jusqu'à 256 px après) repoussait le dernier
// message hors de l'écran — ouverture « au milieu », selon le démarrage de la
// session. On rejoue un démarrage à froid (rechargement → l'app rouvre la
// dernière conversation) avec des images servies en retard.
//
// `bypassCSP` : le stack e2e sert l'API en http://localhost:4001, que la CSP de
// nginx (`img-src … https:`) refuse pour les images (cf. attachments-mobile).
test.use({ viewport: { width: 360, height: 705 }, bypassCSP: true });

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
const tag = () => `scr_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

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
  const hideBanner = page.getByRole("button", { name: "Masquer" });
  if (await hideBanner.count()) await hideBanner.click();
}

// PNG réel généré par le navigateur (canvas) : la vignette a de vraies
// dimensions naturelles, donc grandit vraiment une fois chargée.
async function pngOf(page, width, height) {
  const b64 = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#3f0e40";
      ctx.fillRect(0, 0, w, h);
      return c.toDataURL("image/png").split(",")[1];
    },
    [width, height]
  );
  return Buffer.from(b64, "base64");
}

async function sendText(page, text) {
  const composer = page.getByPlaceholder(/^Message dans/);
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.getByText(text)).toBeVisible();
}

async function sendImage(page, file, text) {
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText(file.name)).toBeVisible();
  await sendText(page, text);
}

test("ouverture d'une conversation : collée au dernier message malgré des images lentes", async ({
  page,
}) => {
  await bootstrapAdmin(page);
  const png = await pngOf(page, 300, 900);
  for (let i = 1; i <= 6; i++) {
    await sendImage(page, { name: `photo-${i}.png`, mimeType: "image/png", buffer: png }, `photo ${i}`);
  }
  const last = `dernier message ${tag()}`;
  await sendText(page, last);
  // Conversation mémorisée : le rechargement la rouvrira d'elle-même.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some((k) => k.startsWith("murgat:lastChannel:"))
      )
    )
    .toBe(true);

  // Vignettes servies avec 1,5 s de retard. Activer le routage coupe aussi le
  // cache HTTP : au rechargement, chaque image est bien redemandée.
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() === "image") {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.continue();
  });
  await page.reload();

  const lastMessage = page.getByText(last);
  await expect(lastMessage).toBeAttached();
  const scroller = page.locator(".overflow-y-auto").filter({ has: lastMessage });
  // Toutes les vignettes chargées : elles ont désormais leur hauteur finale…
  await expect
    .poll(
      () =>
        scroller.evaluate((el) => {
          const imgs = Array.from(el.querySelectorAll("img"));
          return imgs.length >= 6 && imgs.every((img) => img.complete && img.naturalWidth > 0);
        }),
      { timeout: 20_000 }
    )
    .toBe(true);
  // …et la vue est restée collée au bas, dernier message à l'écran.
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), {
      timeout: 3_000,
    })
    .toBeLessThan(60);
  await expect(lastMessage).toBeInViewport();
});
