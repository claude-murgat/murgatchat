import { test, expect } from "@playwright/test";

// Salons gérés par leurs membres (1.6.0) — les parcours demandés :
//   - créer un salon par le « + » de la section, en trois étapes (nom,
//     visibilité, personnes), comme dans Slack ;
//   - « Nouveau message » à plusieurs = un salon privé, et le salon déjà formé
//     avec ces personnes est proposé plutôt qu'un double ;
//   - tout membre renomme et retire quelqu'un (qui en est prévenu) ; seul un
//     admin supprime ;
//   - quitter un salon, masquer une conversation directe (elle revient au
//     prochain message) ;
//   - chaque changement laisse une trace dans le salon (message de service).

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
// Requêtes côté Node : forcer IPv4 (Windows résout "localhost" en ::1).
const API = API_URL.replace("localhost", "127.0.0.1");
const tag = () => `sal_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

test.beforeEach(async ({ request }) => {
  const res = await request.post(`${API}/test/reset`);
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`/test/reset failed: HTTP ${res.status()}`);
  }
});

async function call(request, token, method, path, data) {
  const res = await request.fetch(`${API}${path}`, {
    method,
    data,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok()) throw new Error(`${method} ${path} → HTTP ${res.status()} ${await res.text()}`);
  return res.json();
}

// Un admin (bootstrap) et trois comptes invités : Alice, Bob, Carol.
async function setup(request) {
  const a = tag();
  const admin = await call(request, null, "POST", "/auth/register", {
    email: `${a}@e2e.local`,
    username: a,
    displayName: `Admin ${a}`,
    password: "test1234",
  });
  const invite = async (first) => {
    const t = tag();
    const { token } = await call(request, admin.token, "POST", "/auth/invitations", {
      email: `${t}@e2e.local`,
    });
    return call(request, null, "POST", "/auth/register", {
      email: `${t}@e2e.local`,
      username: t,
      displayName: `${first} ${t}`,
      password: "test1234",
      token,
    });
  };
  return { admin, alice: await invite("Alice"), bob: await invite("Bob"), carol: await invite("Carol") };
}

// Ouvre l'app déjà connectée : jeton + adresse serveur posés avant le boot.
async function openAs(browser, session) {
  const context = await browser.newContext();
  await context.addInitScript(
    ([token, base]) => {
      localStorage.setItem("chat_token", token);
      localStorage.setItem("chat_api_base", base);
    },
    [session.token, API_URL]
  );
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Général/ })).toBeVisible();
  return page;
}

const sidebarItem = (page, name) => page.getByRole("button", { name: new RegExp(name) }).first();
// La ligne d'une personne dans un sélecteur (case à cocher + nom).
const personRow = (dialog, who) => dialog.locator("label").filter({ hasText: who.user.displayName });
const systemLine = (page, text) => page.locator("[data-system-message]").filter({ hasText: text });

async function openSalon(page, name) {
  await sidebarItem(page, name).click();
  await expect(page.getByPlaceholder(`Message dans #${name}`)).toBeVisible();
}

test("créer un salon par le « + » de la section, en trois étapes, et y ajouter quelqu'un", async ({
  browser,
  request,
}) => {
  const { alice, bob } = await setup(request);
  const bobPage = await openAs(browser, bob);
  const page = await openAs(browser, alice);
  const name = `projet-${tag()}`;

  await page.getByRole("button", { name: "Ajouter un salon" }).click();
  await page.getByRole("menuitem", { name: "Créer un salon" }).click();
  const dialog = page.getByRole("dialog", { name: "Créer un salon" });
  await dialog.getByPlaceholder("ex. projet-chantier").fill(name);
  await dialog.getByRole("button", { name: "Suivant" }).click();
  await expect(dialog.getByText("Étape 2 sur 2")).toBeVisible();
  await dialog.getByText("Privé", { exact: true }).click();
  await dialog.getByRole("button", { name: "Créer", exact: true }).click();

  // Étape 3 : ajouter Bob au salon tout juste créé.
  const people = page.getByRole("dialog", { name: "Ajouter des personnes" });
  await people.getByPlaceholder("Saisir un nom").fill(bob.user.displayName);
  await personRow(people, bob).getByRole("checkbox").check();
  await people.getByRole("button", { name: "Ajouter (1)" }).click();
  await expect(people).toBeHidden();

  // Le salon s'ouvre, privé ; l'ajout y laisse sa trace.
  await expect(page.getByRole("button", { name: `🔒 ${name}` }).first()).toBeVisible();
  await expect(systemLine(page, `a ajouté ${bob.user.displayName} au salon`)).toBeVisible();

  // Bob est prévenu, et le salon apparaît dans sa liste.
  await expect(bobPage.getByText(`${alice.user.displayName} vous a ajouté`)).toBeVisible();
  await expect(sidebarItem(bobPage, name)).toBeVisible();
});

test("« Nouveau message » à plusieurs crée un salon privé, puis propose celui qui existe", async ({
  browser,
  request,
}) => {
  const { alice, bob, carol } = await setup(request);
  const page = await openAs(browser, alice);

  // On coche la ligne de la personne (pas « la première ») : la liste suit la
  // recherche avec un léger délai, la première ligne peut encore être l'ancienne.
  const pick = async (dialog, who) => {
    await dialog.getByPlaceholder(/Rechercher une ou plusieurs personnes/).fill(who.user.displayName);
    await personRow(dialog, who).getByRole("checkbox").check();
  };

  await page.getByRole("button", { name: "Nouveau message" }).click();
  let dialog = page.getByRole("dialog", { name: "Nouveau message" });
  await pick(dialog, bob);
  await pick(dialog, carol);
  // Nom proposé : les trois participants, par ordre alphabétique.
  const expected = [alice, bob, carol].map((u) => u.user.displayName).sort().join(", ");
  await expect(dialog.getByLabel("Nom du salon privé")).toHaveValue(expected);
  await dialog.getByRole("button", { name: "Créer le salon privé (3)" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByPlaceholder(`Message dans #${expected}`)).toBeVisible();

  // Mêmes personnes une seconde fois : le salon existant est proposé.
  await page.getByRole("button", { name: "Nouveau message" }).click();
  dialog = page.getByRole("dialog", { name: "Nouveau message" });
  await pick(dialog, carol);
  await pick(dialog, bob);
  await expect(dialog.getByText("Vous avez déjà")).toBeVisible();
  await dialog.getByRole("button", { name: "Ouvrir" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByPlaceholder(`Message dans #${expected}`)).toBeVisible();
});

test("un membre renomme le salon et retire quelqu'un, qui en est prévenu ; il ne peut pas le supprimer", async ({
  browser,
  request,
}) => {
  const { alice, bob, carol } = await setup(request);
  const { channel } = await call(request, alice.token, "POST", "/channels", {
    name: `equipe-${tag()}`,
    isPrivate: true,
    memberIds: [bob.user.id, carol.user.id],
  });
  const carolPage = await openAs(browser, carol);
  const page = await openAs(browser, bob); // Bob n'a pas créé le salon
  await openSalon(page, channel.name);

  await page.getByRole("button", { name: "Détails du salon" }).click();
  const details = page.getByRole("dialog", { name: /^Détails de/ });
  // Pas d'admin : pas de suppression.
  await expect(details.getByRole("button", { name: "Supprimer le salon" })).toHaveCount(0);
  const renamed = `${channel.name}-bis`;
  await details.getByLabel("Nom").fill(renamed);
  await details.getByRole("button", { name: "Enregistrer" }).click();
  await expect(systemLine(page, `a renommé le salon en « ${renamed} »`)).toBeVisible();
  await expect(sidebarItem(carolPage, renamed)).toBeVisible();

  await details.getByRole("tab", { name: /Membres/ }).click();
  await details
    .locator("div.rounded-md")
    .filter({ hasText: carol.user.displayName })
    .getByRole("button", { name: "Retirer" })
    .click();
  await expect(systemLine(page, `a retiré ${carol.user.displayName} du salon`)).toBeVisible();

  // Carol l'apprend, et le salon quitte sa liste.
  await expect(carolPage.getByText(`${bob.user.displayName} vous a retiré du salon`)).toBeVisible();
  await expect(carolPage.getByRole("button", { name: new RegExp(renamed) })).toHaveCount(0);
});

test("quitter un salon depuis le menu contextuel ; les autres en voient la trace", async ({
  browser,
  request,
}) => {
  const { alice, bob } = await setup(request);
  const { channel } = await call(request, alice.token, "POST", "/channels", {
    name: `libre-${tag()}`,
    memberIds: [bob.user.id],
  });
  const alicePage = await openAs(browser, alice);
  await openSalon(alicePage, channel.name);
  const page = await openAs(browser, bob);

  await sidebarItem(page, channel.name).click({ button: "right" });
  await page.getByRole("button", { name: "Quitter le salon" }).click(); // confirmé (dialog accepté)
  await expect(page.getByRole("button", { name: new RegExp(channel.name) })).toHaveCount(0);
  await expect(systemLine(alicePage, "a quitté le salon")).toBeVisible();
});

test("masquer une conversation directe : elle revient au prochain message", async ({
  browser,
  request,
}) => {
  const { alice, bob } = await setup(request);
  await call(request, alice.token, "POST", "/channels/dm", { userId: bob.user.id });
  const page = await openAs(browser, alice);
  const bobPage = await openAs(browser, bob);

  const dmWithBob = page.getByRole("button", { name: new RegExp(bob.user.displayName) });
  await dmWithBob.first().click({ button: "right" });
  await page.getByRole("button", { name: "Masquer la conversation" }).click();
  await expect(dmWithBob).toHaveCount(0);

  // Bob écrit : la conversation réapparaît chez Alice.
  await bobPage.getByRole("button", { name: new RegExp(alice.user.displayName) }).first().click();
  const composer = bobPage.getByPlaceholder(/^Message à /);
  await composer.fill("coucou après masquage");
  await composer.press("Enter");
  await expect(dmWithBob.first()).toBeVisible();
});

test("un admin supprime un salon depuis ses détails, pour tous ses membres", async ({
  browser,
  request,
}) => {
  const { admin, alice } = await setup(request);
  const { channel } = await call(request, alice.token, "POST", "/channels", {
    name: `fin-${tag()}`,
    memberIds: [admin.user.id],
  });
  const alicePage = await openAs(browser, alice);
  await expect(sidebarItem(alicePage, channel.name)).toBeVisible();
  const page = await openAs(browser, admin);
  await openSalon(page, channel.name);

  await page.getByRole("button", { name: "Détails du salon" }).click();
  const details = page.getByRole("dialog", { name: /^Détails de/ });
  await details.getByRole("button", { name: "Supprimer le salon" }).click();
  await details.getByRole("button", { name: "Confirmer la suppression" }).click();
  await expect(details).toBeHidden();
  await expect(alicePage.getByRole("button", { name: new RegExp(channel.name) })).toHaveCount(0);
});
