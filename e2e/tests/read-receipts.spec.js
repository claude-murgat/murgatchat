import { test, expect } from "@playwright/test";

// Accusés de lecture (1.7.0) :
//   - sous le dernier message qu'un membre a vu, son avatar ; son nom au survol ;
//   - au survol d'un message, « Vu par … » ;
//   - « vu » = affiché à l'écran : une conversation ouverte mais pas défilée
//     n'est vue que jusqu'où elle a paru, et la rouvrir reprend au premier
//     message jamais affiché (« Nouveaux messages »).

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
// Requêtes côté Node : forcer IPv4 (Windows résout "localhost" en ::1).
const API = API_URL.replace("localhost", "127.0.0.1");
const tag = () => `vu_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

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
  return { alice: await invite("Alice"), bob: await invite("Bob"), carol: await invite("Carol") };
}

// Ouvre l'app déjà connectée : jeton + adresse serveur posés avant le boot.
async function openAs(browser, session, viewport) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  await context.addInitScript(
    ([token, base]) => {
      localStorage.setItem("chat_token", token);
      localStorage.setItem("chat_api_base", base);
    },
    [session.token, API_URL]
  );
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Général/ })).toBeVisible();
  return page;
}

const open = async (page, name, placeholder) => {
  await page.getByRole("button", { name: new RegExp(name) }).first().click();
  await expect(page.getByPlaceholder(placeholder)).toBeVisible();
};

async function send(page, text) {
  const composer = page.getByPlaceholder(/^Message (dans|à) /);
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

const seenMarker = (page, label) => page.getByRole("img", { name: label });
// Numéro de la « ligne N » sous laquelle sont posés des avatars (null : aucun).
const markedLine = (marker) =>
  marker.evaluate((el) => {
    const item = el.parentElement?.parentElement;
    const m = item?.textContent?.match(/ligne (\d+)/);
    return m ? Number(m[1]) : null;
  });

test("un message vu : l'avatar du lecteur dessous, son nom au survol, « Vu par » au survol du message", async ({
  browser,
  request,
}) => {
  const { alice, bob } = await setup(request);
  await call(request, alice.token, "POST", "/channels/dm", { userId: bob.user.id });
  const alicePage = await openAs(browser, alice);
  const bobPage = await openAs(browser, bob);
  await open(alicePage, bob.user.displayName, /^Message à /);
  await send(alicePage, "Coucou Bob");

  // Bob ouvre la conversation : chez Alice, son avatar arrive en direct.
  const label = `Vu par ${bob.user.displayName}`;
  const marker = seenMarker(alicePage, label);
  await expect(marker).toHaveCount(0);
  await open(bobPage, alice.user.displayName, /^Message à /);
  await expect(marker).toBeVisible();
  await marker.hover();
  await expect(marker.getByText(label)).toBeVisible();

  const row = alicePage.locator("div.group").filter({ hasText: "Coucou Bob" }).last();
  await row.hover();
  await expect(row.getByText(label)).toBeVisible();

  // Chez Bob : ni accusé pour lui-même, ni pour Alice sous son propre message.
  await expect(bobPage.getByRole("img", { name: /^Vu par/ })).toHaveCount(0);
});

test("dans un salon : un avatar par membre qui a vu, tous les noms au survol", async ({
  browser,
  request,
}) => {
  const { alice, bob, carol } = await setup(request);
  const name = `vu-${tag()}`;
  await call(request, alice.token, "POST", "/channels", {
    name,
    memberIds: [bob.user.id, carol.user.id],
  });
  const alicePage = await openAs(browser, alice);
  const bobPage = await openAs(browser, bob);
  const carolPage = await openAs(browser, carol);
  await open(alicePage, name, `Message dans #${name}`);
  await send(alicePage, "Réunion à 14 h");
  await open(bobPage, name, `Message dans #${name}`);
  await open(carolPage, name, `Message dans #${name}`);

  const label = `Vu par ${bob.user.displayName} et ${carol.user.displayName}`;
  const marker = seenMarker(alicePage, label);
  await expect(marker).toBeVisible();
  await marker.hover();
  await expect(marker.getByText(label)).toBeVisible();
  // Chez Bob, seule Carol (lui-même et l'autrice sont écartés).
  await expect(seenMarker(bobPage, `Vu par ${carol.user.displayName}`)).toBeVisible();
});

test("lecture partielle : l'avatar s'arrête au dernier message affiché, la reprise se fait au suivant", async ({
  browser,
  request,
}) => {
  const { alice, bob } = await setup(request);
  await call(request, alice.token, "POST", "/channels/dm", { userId: bob.user.id });
  const alicePage = await openAs(browser, alice);
  // Fenêtre basse : une trentaine de lignes ne tiennent pas à l'écran.
  const bobPage = await openAs(browser, bob, { width: 1000, height: 520 });
  await open(alicePage, bob.user.displayName, /^Message à /);
  for (let i = 1; i <= 30; i++) await send(alicePage, `ligne ${i}`);

  // Bob ouvre sur la première ligne non lue, n'en voit que le haut et repart.
  await open(bobPage, alice.user.displayName, /^Message à /);
  await expect(bobPage.getByText("Nouveaux messages")).toBeVisible();
  const marker = seenMarker(alicePage, `Vu par ${bob.user.displayName}`);
  await expect(marker).toBeVisible();
  await open(bobPage, "Général", "Message dans #Général");
  // Position finale, une fois arrivé le dernier signalement de Bob.
  let seenUpTo = null;
  await expect
    .poll(async () => {
      const prev = seenUpTo;
      seenUpTo = await markedLine(marker);
      return prev !== null && prev === seenUpTo;
    }, { intervals: [500] })
    .toBe(true);
  expect(seenUpTo).toBeGreaterThan(1);
  expect(seenUpTo).toBeLessThan(30);

  // Il revient : la reprise se fait juste après ce qu'il a vu.
  await open(bobPage, alice.user.displayName, /^Message à /);
  const separator = bobPage.getByText("Nouveaux messages");
  await expect(separator).toBeVisible();
  const resumeAt = await separator.evaluate((el) => {
    const m = el.parentElement?.parentElement?.textContent?.match(/ligne (\d+)/);
    return m ? Number(m[1]) : null;
  });
  expect(resumeAt).toBe(seenUpTo + 1);

  // Il défile jusqu'en bas : son avatar descend sous la dernière ligne.
  await bobPage.getByText(`ligne ${seenUpTo}`, { exact: true }).hover();
  await bobPage.mouse.wheel(0, 5000);
  await expect.poll(() => markedLine(marker)).toBe(30);
});
