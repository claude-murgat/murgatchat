import { test, expect } from "@playwright/test";

// Démarrage de la PWA mobile sur un réseau instable : l'app doit rouvrir la
// dernière conversation, sans écran intermédiaire trompeur.
//
// La dernière conversation n'était rouverte que par le PREMIER chargement de la
// liste des salons. S'il échouait, la resynchro (connexion du socket) remplissait
// la liste mais l'app restait dessus. S'il était lent, la liste s'affichait vide
// (« Aucun salon ») pendant le chargement, puis l'app basculait sur la conversation.

test.use({ viewport: { width: 360, height: 705 } });

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
// Requêtes côté Node : forcer IPv4 (Windows résout "localhost" en ::1).
const API = API_URL.replace("localhost", "127.0.0.1");
const tag = () => `net_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

test.beforeEach(async ({ request }) => {
  const res = await request.post(`${API}/test/reset`);
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`/test/reset failed: HTTP ${res.status()}`);
  }
});

// Compte + salon « projet » créés par l'API, puis page déjà connectée dont la
// dernière conversation vue est « projet » (pas le 1er salon de la liste).
async function coldStartPage(browser, request) {
  const t = tag();
  const reg = await request.post(`${API}/auth/register`, {
    data: { email: `${t}@e2e.local`, username: t, displayName: `Admin ${t}`, password: "test1234" },
  });
  expect(reg.ok()).toBeTruthy();
  const { token, user } = await reg.json();
  const created = await request.post(`${API}/channels`, {
    data: { name: "projet" },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(created.ok()).toBeTruthy();
  const { channel } = await created.json();
  const context = await browser.newContext();
  await context.addInitScript(
    ([tok, base, key, channelId]) => {
      localStorage.setItem("chat_token", tok);
      localStorage.setItem("chat_api_base", base);
      localStorage.setItem(key, channelId);
    },
    [token, API_URL, `murgat:lastChannel:${user.id}`, channel.id]
  );
  return context.newPage();
}

test("1re liste des salons en échec : la dernière conversation est quand même rouverte", async ({
  browser,
  request,
}) => {
  const page = await coldStartPage(browser, request);
  let calls = 0;
  await page.route("**/channels", (route) =>
    ++calls === 1 ? route.abort("internetdisconnected") : route.continue()
  );
  await page.goto("/");

  await expect(page.getByPlaceholder("Message dans #projet")).toBeVisible();
  expect(calls).toBeGreaterThanOrEqual(2);
});

test("liste des salons lente : pas de liste vide avant la dernière conversation", async ({
  browser,
  request,
}) => {
  const page = await coldStartPage(browser, request);
  // Relève tout affichage, même bref, de la liste vide pendant le démarrage.
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.body?.innerText.includes("Aucun salon")) window.__sawEmptyList = true;
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.route("**/channels", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto("/");

  await expect(page.getByPlaceholder("Message dans #projet")).toBeVisible();
  expect(await page.evaluate(() => window.__sawEmptyList ?? false)).toBe(false);
});
