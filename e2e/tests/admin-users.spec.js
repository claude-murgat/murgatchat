import { test, expect } from "@playwright/test";

// Panneau d'administration : désactivation puis suppression définitive d'un
// utilisateur. Régression : un compte désactivé gardait sa session ouverte — son
// socket, jamais revérifié, lui laissait recevoir et envoyer des messages.

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
// Requêtes côté Node : forcer IPv4 (voir session.spec.js).
const API = API_URL.replace("localhost", "127.0.0.1");
const tag = () => `adm_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

test.beforeEach(async ({ request }) => {
  const res = await request.post(`${API}/test/reset`);
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`/test/reset failed: HTTP ${res.status()}`);
  }
});

// Compte créé par l'API : le premier (bootstrap) est propriétaire, les suivants
// passent par une invitation du propriétaire.
async function createAccount(request, displayName, ownerToken) {
  const t = tag();
  const email = `${t}@e2e.local`;
  let invitation;
  if (ownerToken) {
    const inv = await request.post(`${API}/auth/invitations`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
      data: { email },
    });
    expect(inv.ok()).toBeTruthy();
    invitation = (await inv.json()).token;
  }
  const res = await request.post(`${API}/auth/register`, {
    data: { email, username: t, displayName, password: "test1234", token: invitation },
  });
  expect(res.ok()).toBeTruthy();
  return res.json(); // { token, user }
}

// Page déjà connectée : jeton et adresse du serveur posés avant le démarrage.
async function signedInPage(browser, token) {
  const context = await browser.newContext();
  await context.addInitScript(
    ([tok, base]) => {
      // Une seule fois : un rechargement ne doit pas réinjecter un jeton effacé.
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("chat_token", tok);
      localStorage.setItem("chat_api_base", base);
    },
    [token, API_URL]
  );
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByPlaceholder("Message dans #Général")).toBeVisible();
  return page;
}

test("désactiver ferme la session du membre, puis la suppression efface son compte et ses messages", async ({
  browser,
  request,
}) => {
  const owner = await createAccount(request, "Patronne E2E");
  const member = await createAccount(request, "Membre E2E", owner.token);

  const memberPage = await signedInPage(browser, member.token);
  const ownerPage = await signedInPage(browser, owner.token);

  const composer = memberPage.getByPlaceholder("Message dans #Général");
  await composer.fill("message à effacer");
  await composer.press("Enter");
  await expect(ownerPage.getByText("message à effacer")).toBeVisible();

  await ownerPage.getByRole("button", { name: /Patronne E2E/ }).first().click();
  await ownerPage.getByRole("button", { name: "Administration" }).click();
  const row = ownerPage.locator("li").filter({ hasText: `@${member.user.username}` });
  // Rien d'irréversible tant que le compte est actif.
  await expect(row.getByRole("button", { name: "Supprimer définitivement" })).toHaveCount(0);

  // 1. Désactivation : la session déjà ouverte du membre est fermée sur-le-champ.
  await row.getByRole("button", { name: "Désactiver" }).click();
  await ownerPage.getByRole("button", { name: "Confirmer" }).click();
  await expect(row.getByText("Désactivé")).toBeVisible();
  await expect(
    memberPage.getByText("Votre accès a été retiré par un administrateur.")
  ).toBeVisible();
  await expect(memberPage.getByPlaceholder("email ou nom d'utilisateur")).toBeVisible();
  expect(await memberPage.evaluate(() => localStorage.getItem("chat_token"))).toBeNull();

  // 2. Suppression définitive, proposée une fois le compte désactivé.
  await row.getByRole("button", { name: "Supprimer définitivement" }).click();
  await expect(ownerPage.getByText(/Action irréversible/)).toBeVisible();
  // Le bouton de la confirmation (rendue après la liste).
  await ownerPage.getByRole("button", { name: "Supprimer définitivement" }).last().click();
  await expect(row).toHaveCount(0);

  // Son message a disparu en direct du fil resté ouvert derrière le panneau.
  await ownerPage.getByRole("button", { name: "Fermer" }).click();
  await expect(ownerPage.getByText("message à effacer")).toHaveCount(0);

  const login = await request.post(`${API}/auth/login`, {
    data: { emailOrUsername: member.user.username, password: "test1234" },
  });
  expect(login.status()).toBe(401);
});
