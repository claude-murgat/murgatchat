import { test, expect } from "@playwright/test";

// Régression #95 — démarrage à froid d'une PWA mobile droit dans une conversation.
//
// Au lancement, l'app rouvre la dernière conversation vue (saveLastChannelId), si
// bien que sur mobile elle s'affiche directement sur la conversation, pas sur la
// liste. La PWA fraîchement lancée n'a qu'UNE entrée d'historique (l'entrée de
// lancement). Le sentinel "fermer la conversation" renvoie sur cette entrée de
// lancement — ce qui, sur les PWA Android, décharge le document en un écran noir
// gelé au lieu de révéler la liste des salons.
//
// Le correctif sème une entrée de garde au démarrage (mobile, historique vide) :
// le bouton retour système atterrit toujours sur une vraie vue in-app (la liste)
// sans jamais s'échapper de la PWA. Chromium ne reproduit pas le gel "écran noir"
// propre à Firefox/Android, mais reproduit fidèlement l'invariant sous-jacent :
// après plusieurs "retour" système, l'app reste affichée au lieu de quitter le
// document (sans la garde, le second retour quitte la PWA).

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
const tag = () => `b95_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

async function configureServer(page) {
  const server = page.getByPlaceholder(/Adresse du serveur/);
  await expect(server).toBeVisible();
  await server.fill(API_URL);
  await page.getByRole("button", { name: "Tester" }).click();
  await expect(page.getByText(/joignable/)).toBeVisible();
}

// Premier compte (DB vierge) : le serveur le bootstrap en admin.
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
  // Connecté : le salon général est auto-sélectionné (et mémorisé comme dernière
  // conversation vue).
  await expect(page.getByRole("button", { name: /Général/ })).toBeVisible();
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
  // La dernière conversation doit avoir été mémorisée pour rejouer l'auto-ouverture.
  expect(
    Object.keys(storage).some((k) => k.startsWith("murgat:lastChannel:"))
  ).toBe(true);

  // 2) Démarrage à froid simulé : contexte neuf, viewport mobile, session injectée
  //    AVANT le chargement, puis UN SEUL goto (historique = 1 entrée de lancement).
  const ctx = await browser.newContext({ viewport: { width: 360, height: 705 } });
  const page = await ctx.newPage();
  await page.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, storage);
  await page.goto("/");

  // 3) L'app rouvre la conversation : sur mobile, le bouton retour in-app (md:hidden)
  //    est visible — preuve qu'on est bien sur la conversation, pas sur la liste.
  const backToList = page.getByRole("button", {
    name: "Retour à la liste des conversations",
  });
  await expect(backToList).toBeVisible();

  // La garde a été semée : l'entrée de lancement n'est plus la cible du retour.
  // Sans le correctif, history.length vaudrait 2 (lancement + sentinel) et le
  // retour retomberait sur l'entrée de lancement (écran noir Android).
  const len = await page.evaluate(() => window.history.length);
  expect(len).toBeGreaterThanOrEqual(3);

  // 4) Retour système n°1 → ferme la conversation, affiche la liste des salons.
  await page.evaluate(() => window.history.back());
  await expect(page.getByRole("button", { name: /Général/ })).toBeVisible();
  await expect(backToList).toBeHidden();

  // 5) Retour système n°2 → grâce à la garde, on reste DANS l'app (la liste reste
  //    affichée) au lieu de quitter le document. Sans la garde, ce retour
  //    sortirait de la PWA (écran noir).
  await page.evaluate(() => window.history.back());
  await page.waitForTimeout(300);
  await expect(page.getByRole("button", { name: /Général/ })).toBeVisible();

  await ctx.close();
});
