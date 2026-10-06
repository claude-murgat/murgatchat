import { test, expect } from "@playwright/test";

// Reprise de session au démarrage (app desktop sur TSE, PWA hors ligne).
//
// Au lancement, l'app vérifie le jeton enregistré via GET /auth/me. Elle l'effaçait
// au MOINDRE échec : l'app desktop, lancée à l'ouverture de session sur le TSE
// souvent avant que le réseau soit prêt, déconnectait ainsi l'utilisateur, obligé
// de se reconnecter. Seul un refus du serveur (401) doit déconnecter ; un serveur
// injoignable garde la session et la reprend dès son retour.

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
// Requêtes côté Node : forcer IPv4 (Windows résout "localhost" en ::1, où le
// serveur lié en IPv4 refuse la connexion ; Linux/CI n'est pas concerné).
const API = API_URL.replace("localhost", "127.0.0.1");
const tag = () => `sess_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

// DB vierge avant chaque tentative (POST /test/reset, gated par E2E_TEST_MODE ;
// un 404 — stack sans cette option — est toléré).
test.beforeEach(async ({ request }) => {
  const res = await request.post(`${API}/test/reset`);
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`/test/reset failed: HTTP ${res.status()}`);
  }
});

// Compte bootstrap créé par l'API, puis page « déjà connectée » : jeton et
// adresse du serveur posés dans le localStorage avant le démarrage de l'app.
async function signedInPage(browser, request) {
  const t = tag();
  const res = await request.post(`${API}/auth/register`, {
    data: { email: `${t}@e2e.local`, username: t, displayName: `Admin ${t}`, password: "test1234" },
  });
  expect(res.ok()).toBeTruthy();
  const { token } = await res.json();
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
  return { page: await context.newPage(), token };
}

test("serveur injoignable au démarrage : la session est gardée puis reprise", async ({
  browser,
  request,
}) => {
  const { page, token } = await signedInPage(browser, request);
  // Le réseau n'est pas prêt au lancement (ouverture de session TSE, PWA hors ligne).
  await page.route("**/auth/me", (route) => route.abort("internetdisconnected"));
  await page.goto("/");

  await expect(page.getByText("Serveur injoignable")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("chat_token"))).toBe(token);

  // Le réseau revient : la session reprend toute seule, sans ressaisir d'identifiants.
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.getByRole("button", { name: /Général/ }).first()).toBeVisible({
    timeout: 15_000,
  });
});

test("« Réessayer maintenant » reprend la session sans attendre", async ({ browser, request }) => {
  const { page } = await signedInPage(browser, request);
  await page.route("**/auth/me", (route) => route.abort("internetdisconnected"));
  await page.goto("/");
  await expect(page.getByText("Serveur injoignable")).toBeVisible();

  await page.unrouteAll({ behavior: "wait" });
  await page.getByRole("button", { name: "Réessayer maintenant" }).click();
  await expect(page.getByRole("button", { name: /Général/ }).first()).toBeVisible();
});

test("jeton refusé par le serveur (401) : déconnexion", async ({ browser, request }) => {
  const { page } = await signedInPage(browser, request);
  await page.route("**/auth/me", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 401,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ error: "unauthorized" }),
        })
      : route.continue()
  );
  await page.goto("/");

  await expect(page.getByPlaceholder("email ou nom d'utilisateur")).toBeVisible();
  await expect(page.getByText("Serveur injoignable")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("chat_token"))).toBeNull();
});
