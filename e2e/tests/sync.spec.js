import { test, expect } from "@playwright/test";

// Synchronisation du fil de discussion (PWA, à confirmer sur desktop).
//
// Deux symptômes remontés :
//  1. un message reçu ne s'affichait pas toujours tout seul :
//     a. arrivé PENDANT le chargement d'une conversation, il était écrasé par la
//        réponse HTTP (lue en base avant lui) ;
//     b. après une coupure du socket (PWA en arrière-plan, veille, changement de
//        réseau), rien ne rattrapait les messages manqués — ni dans le fil, ni
//        dans les non-lus de la barre latérale — jusqu'à rouvrir la conversation ;
//  2. en changeant de conversation, le fil de la PRÉCÉDENTE restait affiché tant
//     que la nouvelle chargeait (indéfiniment si le chargement échouait), et une
//     page d'anciens messages encore en vol s'ajoutait à la nouvelle conversation.
//
// Chaque scénario provoque la course de façon déterministe : réponses HTTP
// retenues / en échec via page.route, socket coupé depuis la page.

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
// Requêtes côté Node : forcer IPv4 (Windows résout "localhost" en ::1, où le
// serveur lié en IPv4 refuse la connexion ; Linux/CI n'est pas concerné).
const API = API_URL.replace("localhost", "127.0.0.1");
const tag = () => `sync_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

// DB vierge avant chaque tentative (POST /test/reset, gated par E2E_TEST_MODE ;
// un 404 — stack sans cette option — est toléré).
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

// Deux comptes (admin bootstrap + invité) et un salon privé commun, créés par
// l'API : ce spec teste la synchro, pas l'inscription (couverte par journey).
async function setup(request) {
  const a = tag();
  const admin = await call(request, null, "POST", "/auth/register", {
    email: `${a}@e2e.local`,
    username: a,
    displayName: `Admin ${a}`,
    password: "test1234",
  });
  const b = tag();
  const { token: invitation } = await call(request, admin.token, "POST", "/auth/invitations", {
    email: `${b}@e2e.local`,
  });
  const peer = await call(request, null, "POST", "/auth/register", {
    email: `${b}@e2e.local`,
    username: b,
    displayName: `Pair ${b}`,
    password: "test1234",
    token: invitation,
  });
  const { channel: priv } = await call(request, admin.token, "POST", "/channels", {
    name: `prive-${a}`,
    isPrivate: true,
    memberIds: [peer.user.id],
  });
  const { channels } = await call(request, admin.token, "GET", "/channels");
  const general = channels.find((c) => c.name === "Général");
  return { admin, peer, priv, general };
}

// Ouvre l'app déjà connectée : jeton + adresse serveur posés avant le boot.
// `prepare` installe les interceptions qui doivent précéder le 1er socket.
async function openAs(browser, session, prepare) {
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
  if (prepare) await prepare(page);
  await page.goto("/");
  return page;
}

// La vue conversation (et non la barre latérale).
const chat = (page) =>
  page.locator("section").filter({ has: page.getByPlaceholder(/^Message (dans|à) /) });

async function openChannel(page, name) {
  await page.getByRole("button", { name: new RegExp(name) }).first().click();
  await expect(page.getByPlaceholder(`Message dans #${name}`)).toBeVisible();
}

async function send(page, name, text) {
  const composer = page.getByPlaceholder(`Message dans #${name}`);
  await composer.fill(text);
  await composer.press("Enter");
  await expect(chat(page).getByText(text)).toBeVisible();
}

// Exécute la requête interceptée vers le vrai serveur (côté Node : IPv4 forcé).
const fetchUpstream = (route) =>
  route.fetch({ url: route.request().url().replace("localhost", "127.0.0.1") });

// Retient la réponse d'un GET : la requête part tout de suite (le serveur lit la
// base MAINTENANT) mais la page ne la reçoit qu'à `release()`. Les preflights
// CORS (OPTIONS) passent sans être retenus.
async function holdResponses(page, url, transform) {
  let release;
  const gate = new Promise((r) => (release = r));
  let markSent;
  const sent = new Promise((r) => (markSent = r));
  await page.route(url, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await fetchUpstream(route);
    markSent();
    await gate;
    if (!transform) return route.fulfill({ response });
    return route.fulfill({ response, json: transform(await response.json(), route.request()) });
  });
  return { sent, release: () => release() };
}

// Socket de la page piloté : on coupe la connexion en cours et les reconnexions
// échouent comme sans réseau (connexion refusée) jusqu'au rétablissement — une
// PWA mise en arrière-plan ou un changement de réseau, vus du client.
async function controllableSocket(page) {
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    const open = new Set();
    let blocked = false;
    window.WebSocket = class extends Native {
      constructor(url, protocols) {
        super(blocked ? "ws://127.0.0.1:59999/" : url, protocols);
        open.add(this);
        this.addEventListener("close", () => open.delete(this));
      }
    };
    window.__socketControl = {
      cut() {
        blocked = true;
        for (const ws of open) ws.close();
      },
      restore() {
        blocked = false;
      },
    };
  });
  return {
    cut: () => page.evaluate(() => window.__socketControl.cut()),
    restore: () => page.evaluate(() => window.__socketControl.restore()),
  };
}

test("changer de conversation n'affiche jamais le fil de la précédente", async ({
  browser,
  request,
}) => {
  const { admin, priv, general } = await setup(request);
  const page = await openAs(browser, admin);

  await openChannel(page, priv.name);
  await send(page, priv.name, "seulement-dans-le-prive");
  await openChannel(page, "Général");
  await send(page, "Général", "seulement-dans-general");

  // Réponse lente : pendant le chargement, l'ancien fil ne doit pas rester affiché.
  const slow = await holdResponses(page, `**/channels/${priv.id}/messages`);
  await openChannel(page, priv.name);
  await slow.sent;
  await expect(chat(page).getByText("seulement-dans-general")).toHaveCount(0);
  slow.release();
  await expect(chat(page).getByText("seulement-dans-le-prive")).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });

  // Chargement en échec : pas d'ancien fil non plus, mais une erreur + « Réessayer ».
  await page.route(`**/channels/${general.id}/messages`, (route) =>
    route.request().method() === "GET" ? route.abort() : route.continue()
  );
  await openChannel(page, "Général");
  await expect(chat(page).getByRole("button", { name: "Réessayer" })).toBeVisible();
  await expect(chat(page).getByText("seulement-dans-le-prive")).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
  await chat(page).getByRole("button", { name: "Réessayer" }).click();
  await expect(chat(page).getByText("seulement-dans-general")).toBeVisible();
});

test("une page d'anciens messages en vol ne se greffe pas sur la conversation suivante", async ({
  browser,
  request,
}) => {
  const { admin, priv } = await setup(request);
  const page = await openAs(browser, admin);
  await openChannel(page, "Général");
  await send(page, "Général", "dans-general");
  await openChannel(page, priv.name);
  await send(page, priv.name, "dans-le-prive");

  // Le salon privé annonce de l'historique plus ancien (« Charger les messages
  // plus anciens ») ; la page demandée arrivera APRÈS le passage sur Général.
  await page.route(`**/channels/${priv.id}/messages`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await fetchUpstream(route);
    const body = await response.json();
    return route.fulfill({
      response,
      json: { ...body, hasMore: true, nextCursor: body.messages[0]?.id ?? null },
    });
  });
  await openChannel(page, "Général");
  await openChannel(page, priv.name);
  await expect(chat(page).getByText("dans-le-prive")).toBeVisible();

  const older = await holdResponses(page, `**/channels/${priv.id}/messages?before=*`, (body, req) => {
    const cursor = new URL(req.url()).searchParams.get("before");
    const template = body.messages[0] ?? { author: admin.user, attachments: [], reactions: [] };
    return {
      messages: [
        {
          ...template,
          id: `ancien-${cursor}`,
          channelId: priv.id,
          body: "ancien-message-du-prive",
          createdAt: "2020-01-01T00:00:00.000Z",
          parent: null,
          editedAt: null,
        },
      ],
      hasMore: false,
      nextCursor: null,
      firstUnreadId: null,
    };
  });
  await chat(page).getByRole("button", { name: "Charger les messages plus anciens" }).click();
  await older.sent;
  await openChannel(page, "Général");
  await expect(chat(page).getByText("dans-general")).toBeVisible();
  const delivered = page.waitForResponse((r) => r.url().includes("before="));
  older.release();
  await delivered;
  // Deux frames : React a commité ce que la réponse retenue a pu déclencher.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  );
  await expect(chat(page).getByText("ancien-message-du-prive")).toHaveCount(0);
});

test("un message reçu pendant le chargement de la conversation reste affiché", async ({
  browser,
  request,
}) => {
  const { admin, peer, priv, general } = await setup(request);
  // Trames reçues par le socket de l'admin : preuve que le message temps réel est
  // arrivé avant de libérer la réponse HTTP retenue.
  const frames = [];
  const page = await openAs(browser, admin, (p) =>
    p.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))))
  );
  const other = await openAs(browser, peer);

  await openChannel(other, "Général");
  await send(other, "Général", "deja-la");
  await openChannel(page, priv.name);

  // L'admin ouvre Général : le serveur lit le fil AVANT que le pair ne poste, mais
  // la page ne reçoit cette réponse qu'APRÈS le message temps réel.
  const load = await holdResponses(page, `**/channels/${general.id}/messages`);
  await page.getByRole("button", { name: /Général/ }).first().click();
  await load.sent;
  await send(other, "Général", "arrive-pendant-le-chargement");
  await expect
    .poll(() => frames.some((p) => p.includes("arrive-pendant-le-chargement")))
    .toBe(true);
  load.release();

  await expect(chat(page).getByText("deja-la")).toBeVisible();
  await expect(chat(page).getByText("arrive-pendant-le-chargement")).toBeVisible();
});

test("après une coupure du socket, les messages manqués apparaissent (fil + non-lus)", async ({
  browser,
  request,
}) => {
  const { admin, peer, priv } = await setup(request);
  let socket;
  const page = await openAs(browser, admin, async (p) => {
    socket = await controllableSocket(p);
  });
  const other = await openAs(browser, peer);
  await openChannel(page, "Général");
  await openChannel(other, "Général");
  await send(other, "Général", "avant-la-coupure");
  await expect(chat(page).getByText("avant-la-coupure")).toBeVisible();

  await socket.cut();
  await send(other, "Général", "pendant-la-coupure");
  await openChannel(other, priv.name);
  await send(other, priv.name, "message-prive-manque");
  // Socket coupé : rien n'a pu arriver en temps réel.
  await expect(chat(page).getByText("pendant-la-coupure")).toHaveCount(0);

  await socket.restore();
  // La reconnexion (backoff socket.io ≤ 5 s) doit rattraper ce qui a été manqué.
  await expect(chat(page).getByText("pendant-la-coupure")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: new RegExp(priv.name) }).getByTitle("Non lu")
  ).toBeVisible();

  // Le temps réel refonctionne après la reconnexion.
  await openChannel(other, "Général");
  await send(other, "Général", "apres-la-reconnexion");
  await expect(chat(page).getByText("apres-la-reconnexion")).toBeVisible();
});
