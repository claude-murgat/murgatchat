import { test, expect } from "@playwright/test";

// Issue #319 — recherche par mot-clé dans les conversations.
//
// Le backend (GET /search, FTS Postgres) et le client `api.search` existaient
// déjà mais n'étaient branchés à aucune UI : taper un terme ne renvoyait jamais
// de messages. Le correctif expose ces résultats dans la recherche unifiée de la
// barre latérale (section « Messages ») et ouvre le message cliqué en le mettant
// en évidence. Ce parcours vérifie l'invariant de bout en bout, y compris la
// navigation vers un message situé dans une AUTRE conversation.

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
const tag = () => `s319_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

// DB vierge avant chaque tentative → ce spec bootstrap son propre admin sans
// entrer en conflit avec les autres specs (POST /test/reset gated par
// E2E_TEST_MODE ; un 404 — stack sans cette option — est toléré).
test.beforeEach(async ({ request }) => {
  // Requête côté Node : forcer IPv4 (Windows résout "localhost" en ::1, où le
  // serveur lié en IPv4 refuse la connexion ; Linux/CI n'est pas concerné).
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
  await expect(page.getByRole("button", { name: /Général/ })).toBeVisible();
  return t;
}

// Crée un salon via la recherche unifiée (action « Créer le salon « … » »).
async function createPrivateChannel(page, name) {
  await page.getByPlaceholder(/Rechercher ou créer/).fill(name);
  await page.getByRole("button", { name: /Créer le salon/ }).click();
  await expect(page.getByText("Créer une conversation")).toBeVisible();
  await page.getByPlaceholder("Nom du salon (ex. marketing)").fill(name);
  await page.getByText("Salon privé").click();
  await page.getByRole("button", { name: "Créer" }).click();
  await expect(page.getByText("Créer une conversation")).toBeHidden();
}

test("recherche par mot-clé : liste les messages et ouvre celui cliqué", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await bootstrapAdmin(page);

  // Salon A : on y sème le message à retrouver.
  const chA = `e2e-a-${Date.now().toString(36)}`;
  await createPrivateChannel(page, chA);
  const composerA = page.getByPlaceholder(`Message dans #${chA}`);
  await composerA.fill("le xylophone magique du salon A");
  await composerA.press("Enter");
  await expect(page.getByText("le xylophone magique du salon A")).toBeVisible();

  // Salon B : on bascule ailleurs pour prouver la navigation inter-salons.
  const chB = `e2e-b-${Date.now().toString(36)}`;
  await createPrivateChannel(page, chB);
  await expect(page.getByPlaceholder(`Message dans #${chB}`)).toBeVisible();

  // Recherche du mot-clé depuis la barre latérale : la section « Messages »
  // remonte le message du salon A, terme surligné (<mark>) dans l'extrait.
  await page.getByPlaceholder(/Rechercher ou créer/).fill("xylophone");
  const hit = page.locator("mark", { hasText: /xylophone/i });
  await expect(hit).toBeVisible();

  // Cliquer le résultat ouvre le salon A et met le message en évidence.
  await page
    .getByRole("button")
    .filter({ has: page.locator("mark", { hasText: /xylophone/i }) })
    .click();
  await expect(page.getByPlaceholder(`Message dans #${chA}`)).toBeVisible();
  await expect(page.getByText("le xylophone magique du salon A")).toBeVisible();
});
