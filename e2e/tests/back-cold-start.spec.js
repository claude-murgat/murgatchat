import { test, expect } from "@playwright/test";

// Régression #95 — démarrage à froid d'une PWA mobile droit dans une conversation.
//
// Au lancement, l'app rouvre la dernière conversation vue (saveLastChannelId), si
// bien que sur mobile elle s'affiche directement sur la conversation, pas sur la
// liste. Le sentinel "fermer la conversation" renverrait alors sur l'entrée de
// lancement — ce qui, sur les PWA Android, décharge le document en un écran noir
// gelé au lieu de révéler la liste des salons.
//
// Le correctif sème, sur mobile, une entrée de garde "liste" tant qu'on est encore
// sur l'entrée de lancement (App.jsx, garde #95). Chromium ne reproduit pas le gel
// "écran noir" propre à Android, mais reproduit fidèlement l'invariant : après deux
// "retour" système, l'app reste affichée (liste) au lieu de quitter le document.

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
const tag = () => `b95_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

// Virgin DB before each attempt → ce spec bootstrap son propre admin sans entrer
// en conflit avec les autres specs (POST /test/reset gated par E2E_TEST_MODE ;
// un 404 — stack sans cette option — est toléré).
test.beforeEach(async ({ request }) => {
  // Node-side request: force IPv4 (Windows resolves "localhost" to ::1, where the
  // IPv4-bound server refuses the connection; Linux/CI is unaffected).
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

// Premier compte (DB vierge) : le serveur le bootstrap en admin, puis on ouvre
// explicitement #Général et on ATTEND que la dernière conversation soit persistée
// (le démarrage à froid ci-dessous rejoue cette auto-ouverture depuis le storage).
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
  // Ouvre explicitement le salon général → activeChannelId persiste lastChannel.
  await page.getByRole("button", { name: /Général/ }).first().click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some((k) => k.startsWith("murgat:lastChannel:"))
      )
    )
    .toBe(true);
  return t;
}

test("retour système au démarrage à froid (PWA mobile) : reste dans l'app, sans écran noir", async ({
  browser,
}) => {
  // 1) Compte + session : on bootstrap sur une page normale puis on capture tout
  //    le localStorage (token, URL serveur, dernière conversation mémorisée).
  const setup = await browser.newPage();
  await bootstrapAdmin(setup);
  const storage = await setup.evaluate(() =>
    Object.fromEntries(Object.entries(localStorage))
  );
  await setup.close();
  expect(
    Object.keys(storage).some((k) => k.startsWith("murgat:lastChannel:"))
  ).toBe(true);

  // 2) Démarrage à froid simulé : contexte neuf, viewport mobile, session injectée
  //    AVANT le chargement, puis UN SEUL goto. Le try/catch absorbe l'accès
  //    localStorage refusé sur l'about:blank initial (l'injection réussit au vrai
  //    chargement de "/").
  const ctx = await browser.newContext({ viewport: { width: 360, height: 705 } });
  const page = await ctx.newPage();
  await page.addInitScript((entries) => {
    try {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    } catch {
      /* about:blank : storage indisponible, réessayé au vrai document */
    }
  }, storage);
  await page.goto("/");

  // 3) L'app rouvre la conversation : sur mobile, le bouton retour in-app est visible.
  const backToList = page.getByRole("button", {
    name: "Retour à la liste des conversations",
  });
  await expect(backToList).toBeVisible();

  // La garde "liste" a été semée sous le sentinel conversation → ≥3 entrées in-app,
  // donc le 2ᵉ retour ne peut pas s'échapper du document.
  const len = await page.evaluate(() => window.history.length);
  expect(len).toBeGreaterThanOrEqual(3);

  // 4) Retour système n°1 → ferme la conversation, affiche la liste des salons.
  await page.evaluate(() => window.history.back());
  await expect(page.getByRole("button", { name: /Général/ })).toBeVisible();
  await expect(backToList).toBeHidden();

  // 5) Retour système n°2 → grâce à la garde, on reste DANS l'app (la liste reste
  //    affichée) au lieu de quitter le document (écran noir Android).
  await page.evaluate(() => window.history.back());
  await page.waitForTimeout(300);
  await expect(page.getByRole("button", { name: /Général/ })).toBeVisible();

  await ctx.close();
});
