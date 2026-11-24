import { test, expect } from "@playwright/test";

// Sondages dans les salons : un membre pose une question, choisit le choix
// unique ou multiple et s'il laisse les autres ajouter des réponses ; les votes,
// les réponses ajoutées et la clôture arrivent en direct chez les autres.

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
// Requêtes côté Node : forcer IPv4 (Windows résout "localhost" en ::1).
const API = API_URL.replace("localhost", "127.0.0.1");
const tag = () => `poll_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

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

// Un admin (bootstrap), Alice et Bob, et un salon d'Alice dont Bob est membre.
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
  const alice = await invite("Alice");
  const bob = await invite("Bob");
  const name = `equipe-${Date.now().toString(36)}`;
  const { channel } = await call(request, alice.token, "POST", "/channels", { name });
  await call(request, alice.token, "POST", `/channels/${channel.id}/members`, { userIds: [bob.user.id] });
  return { alice, bob, channel };
}

// Ouvre l'app déjà connectée : jeton + adresse serveur posés avant le boot.
async function openAs(browser, session, options = {}) {
  const context = await browser.newContext(options);
  await context.addInitScript(
    ([token, base]) => {
      localStorage.setItem("chat_token", token);
      localStorage.setItem("chat_api_base", base);
    },
    [session.token, API_URL]
  );
  const page = await context.newPage();
  await page.goto("/");
  await expect(
    options.hasTouch
      ? page.getByPlaceholder("Message dans #Général")
      : page.getByRole("button", { name: /Général/ })
  ).toBeVisible();
  return page;
}

async function openSalon(page, name) {
  await page.getByRole("button", { name: new RegExp(name) }).first().click();
  await expect(page.getByPlaceholder(`Message dans #${name}`)).toBeVisible();
}

const pollCard = (page) => page.getByTestId("poll").last();

test("créer un sondage, voter, changer son vote, ajouter une réponse, clôturer — en direct chez l'autre", async ({
  browser,
  request,
}) => {
  const { alice, bob, channel } = await setup(request);
  const alicePage = await openAs(browser, alice);
  const bobPage = await openAs(browser, bob);
  await openSalon(alicePage, channel.name);
  await openSalon(bobPage, channel.name);

  // Création.
  await alicePage.getByRole("button", { name: "Créer un sondage" }).click();
  const dialog = alicePage.getByRole("dialog", { name: "Créer un sondage" });
  await dialog.getByPlaceholder(/On se retrouve où/).fill("On mange où vendredi ?");
  await dialog.getByLabel("Réponse 1", { exact: true }).fill("Pizzeria");
  await dialog.getByLabel("Réponse 2", { exact: true }).fill("Japonais");
  // Entrée sur la dernière réponse en ouvre une nouvelle, qui prend le focus
  // aussitôt : ce qu'on tape juste après n'atterrit pas dans la précédente.
  await dialog.getByLabel("Réponse 2", { exact: true }).press("Enter");
  await alicePage.keyboard.type("Cantine");
  await expect(dialog.getByLabel("Réponse 2", { exact: true })).toHaveValue("Japonais");
  await expect(dialog.getByLabel("Réponse 3", { exact: true })).toHaveValue("Cantine");
  await dialog.getByLabel("Les membres peuvent ajouter des réponses").check();
  // Un doublon bloque la publication.
  await dialog.getByRole("button", { name: "+ Ajouter une réponse" }).click();
  await dialog.getByLabel("Réponse 4", { exact: true }).fill("  pizzeria ");
  await expect(dialog.getByText("Deux réponses sont identiques.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Publier le sondage" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Retirer la réponse 4" }).click();
  await dialog.getByRole("button", { name: "Publier le sondage" }).click();
  await expect(dialog).toBeHidden();

  // Chez les deux, sans recharger.
  for (const page of [alicePage, bobPage]) {
    await expect(pollCard(page).getByText("On mange où vendredi ?")).toBeVisible();
    await expect(pollCard(page).getByRole("radio")).toHaveCount(3);
    await expect(pollCard(page).getByText("Aucun vote")).toBeVisible();
  }

  // Bob vote, Alice le voit.
  await pollCard(bobPage).getByRole("radio", { name: /Japonais/ }).click();
  await expect(pollCard(bobPage).getByRole("radio", { name: /Japonais/ })).toHaveAttribute("aria-checked", "true");
  await expect(pollCard(alicePage).getByText("1 votant")).toBeVisible();
  await expect(pollCard(alicePage).getByRole("radio", { name: /Japonais/ })).toContainText(bob.user.displayName);

  // Choix unique : un autre clic déplace le vote.
  await pollCard(bobPage).getByRole("radio", { name: /Pizzeria/ }).click();
  await expect(pollCard(alicePage).getByRole("radio", { name: /Pizzeria/ })).toContainText(bob.user.displayName);
  await expect(pollCard(alicePage).getByRole("radio", { name: /Japonais/ })).not.toContainText(
    bob.user.displayName
  );
  await expect(pollCard(bobPage).getByRole("radio", { name: /Japonais/ })).toHaveAttribute("aria-checked", "false");

  // Bob ajoute une réponse (permis par Alice) ; elle arrive chez Alice.
  await pollCard(bobPage).getByRole("button", { name: "+ Ajouter une réponse" }).click();
  await pollCard(bobPage).getByLabel("Nouvelle réponse").fill("Crêperie");
  await pollCard(bobPage).getByRole("button", { name: "Ajouter", exact: true }).click();
  await expect(pollCard(alicePage).getByRole("radio", { name: /Crêperie/ })).toBeVisible();

  // Bob ne peut pas clôturer le sondage d'Alice ; Alice, oui.
  await expect(pollCard(bobPage).getByRole("button", { name: "Clôturer le sondage" })).toHaveCount(0);
  alicePage.once("dialog", (d) => d.accept());
  await pollCard(alicePage).getByRole("button", { name: "Clôturer le sondage" }).click();
  await expect(pollCard(bobPage).getByText("Clôturé", { exact: true })).toBeVisible();
  await expect(pollCard(bobPage).getByRole("radio", { name: /Cantine/ })).toBeDisabled();
  await expect(pollCard(bobPage).getByRole("button", { name: "+ Ajouter une réponse" })).toHaveCount(0);
  // Les résultats restent.
  await expect(pollCard(bobPage).getByRole("radio", { name: /Pizzeria/ })).toContainText(bob.user.displayName);

  // Le message du sondage ne se modifie pas.
  await pollCard(alicePage).hover();
  await expect(alicePage.getByRole("button", { name: "Modifier" })).toHaveCount(0);

  // Après rechargement, tout est là.
  await bobPage.reload();
  await openSalon(bobPage, channel.name);
  await expect(pollCard(bobPage).getByText("Clôturé", { exact: true })).toBeVisible();
  await expect(pollCard(bobPage).getByRole("radio")).toHaveCount(4);
});

test("choix multiple sur téléphone : plusieurs réponses cochées, carte sans débordement", async ({
  browser,
  request,
}) => {
  const { alice, bob, channel } = await setup(request);
  await call(request, alice.token, "POST", "/polls", {
    channelId: channel.id,
    question: "Quels jours êtes-vous disponibles pour la formation sécurité du mois prochain ?",
    options: ["Lundi", "Mardi", "Mercredi (seulement le matin, l'après-midi est pris par l'inventaire)"],
    multiple: true,
  });
  const bobPage = await openAs(browser, bob, {
    viewport: { width: 360, height: 740 },
    hasTouch: true,
    isMobile: true,
  });
  await bobPage.getByRole("button", { name: "Retour à la liste des conversations" }).click();
  const hideBanner = bobPage.getByRole("button", { name: "Masquer", exact: true });
  if (await hideBanner.count()) await hideBanner.first().click();
  await openSalon(bobPage, channel.name);

  const card = pollCard(bobPage);
  await expect(card.getByText("Plusieurs réponses possibles")).toBeVisible();
  await card.getByRole("checkbox", { name: /Lundi/ }).tap();
  await expect(card.getByRole("checkbox", { name: /Lundi/ })).toHaveAttribute("aria-checked", "true");
  await card.getByRole("checkbox", { name: /Mercredi/ }).tap();
  await expect(card.getByRole("checkbox", { name: /Mercredi/ })).toHaveAttribute("aria-checked", "true");
  await expect(card.getByRole("checkbox", { name: /Lundi/ })).toHaveAttribute("aria-checked", "true");
  await expect(card.getByText("1 votant")).toBeVisible();
  // Décocher.
  await card.getByRole("checkbox", { name: /Lundi/ }).tap();
  await expect(card.getByRole("checkbox", { name: /Lundi/ })).toHaveAttribute("aria-checked", "false");

  // Une longue question et une longue réponse n'élargissent pas la page.
  const overflow = await bobPage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("pas de sondage dans un message direct", async ({ browser, request }) => {
  const { alice, bob } = await setup(request);
  await call(request, alice.token, "POST", "/channels/dm", { userId: bob.user.id });
  const alicePage = await openAs(browser, alice);
  await alicePage.getByRole("button", { name: new RegExp(bob.user.displayName) }).first().click();
  await expect(alicePage.getByPlaceholder(/^Message à /)).toBeVisible();
  await expect(alicePage.getByRole("button", { name: "Créer un sondage" })).toHaveCount(0);
  await openSalon(alicePage, "Général");
  await expect(alicePage.getByRole("button", { name: "Créer un sondage" })).toBeVisible();
});
