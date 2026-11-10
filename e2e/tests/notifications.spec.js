import { test, expect } from "@playwright/test";
import http from "node:http";

// Comportement des notifications, côté Android (service worker) et Windows
// (application desktop). Chaque scénario échouait avant le correctif.
//
// Android : le service worker attendait la réponse du serveur (jusqu'à 2,5 s,
// au moment où le téléphone se réveille et n'a pas encore de réseau) avant
// d'afficher la notification.
//
// Windows : l'app n'est pas lancée sous Tauri ici. Un faux `__TAURI_INTERNALS__`
// enregistre les commandes natives et simule la fenêtre ; ce qui se passe ensuite
// dans Windows (toast réellement affiché ou retiré) se vérifie à la main.
//
// Les pushs sont de VRAIS évènements `push` injectés dans le service worker par
// le protocole DevTools. Chromium complet : le headless par défaut refuse la
// permission de notification (cf. push-read-state.spec.js).
test.use({ channel: "chromium", permissions: ["notifications"] });

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
const API = API_URL.replace("localhost", "127.0.0.1");
const tag = () => `ntf_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

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

// Alice (admin du bootstrap) et Bob (invité), tous deux membres de #Général.
async function accounts(request) {
  const a = tag();
  const alice = await call(request, null, "POST", "/auth/register", {
    email: `${a}@e2e.local`,
    username: a,
    displayName: `Alice ${a}`,
    password: "test1234",
  });
  const b = tag();
  const { token } = await call(request, alice.token, "POST", "/auth/invitations", {
    email: `${b}@e2e.local`,
  });
  const bob = await call(request, null, "POST", "/auth/register", {
    email: `${b}@e2e.local`,
    username: b,
    displayName: `Bob ${b}`,
    password: "test1234",
    token,
  });
  return { alice, bob };
}

async function channelOf(request, session, name) {
  const { channels } = await call(request, session.token, "GET", "/channels");
  return channels.find((c) => c.name === name);
}

// `init` : script exécuté avant l'app ; `route` : installé avant le premier chargement.
async function openApp(browser, session, { init, route } = {}) {
  const context = await browser.newContext({ permissions: ["notifications"] });
  await context.addInitScript(
    ([token, base]) => {
      localStorage.setItem("chat_token", token);
      localStorage.setItem("chat_api_base", base);
    },
    [session.token, API_URL]
  );
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  if (route) await route(page);
  await page.goto("/");
  await expect(page.getByPlaceholder("Message dans #Général")).toBeVisible();
  return page;
}

async function say(page, text) {
  const composer = page.getByPlaceholder("Message dans #Général");
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

async function openNotes(page) {
  await page.getByPlaceholder(/^Rechercher/).fill("notes");
  await page.getByRole("button", { name: /Mes notes \(conversation avec soi-même\)/ }).click();
  await expect(page.getByPlaceholder(/^Message à /)).toBeVisible();
  await page.getByPlaceholder(/^Rechercher/).fill("");
}

async function openGeneral(page) {
  await page.getByRole("button", { name: /Général/ }).first().click();
  await expect(page.getByPlaceholder("Message dans #Général")).toBeVisible();
}

// ── Windows : faux runtime Tauri ──────────────────────────────────────────

function fakeTauri() {
  const callbacks = new Map();
  const listeners = new Map();
  let next = 1;
  const win = { visible: true, focused: true, minimized: false };
  window.__win = win;
  window.__calls = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb) {
      callbacks.set(next, cb);
      return next++;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      window.__calls.push({ cmd, args });
      switch (cmd) {
        case "plugin:window|is_visible":
          return win.visible;
        case "plugin:window|is_minimized":
          return win.minimized;
        case "plugin:window|is_focused":
          return win.focused;
        case "plugin:event|listen":
          listeners.set(args.event, [...(listeners.get(args.event) || []), args.handler]);
          return args.handler;
        case "plugin:notification|is_permission_granted":
          return true;
        case "plugin:image|new":
          return 7;
        default:
          return null;
      }
    },
  };
  window.__emit = (event, payload) => {
    for (const id of listeners.get(event) || []) callbacks.get(id)?.({ event, id: 0, payload });
  };
}

const toasts = (page) =>
  page.evaluate(() => window.__calls.filter((c) => c.cmd === "notify_desktop").map((c) => c.args.body));
const clearedChannels = (page) =>
  page.evaluate(() =>
    window.__calls.filter((c) => c.cmd === "clear_desktop_notifications").flatMap((c) => c.args.channelIds)
  );
const forgetCalls = (page) => page.evaluate(() => (window.__calls = []));
// Valeurs successives du point rouge du tray, et de celui de la barre des tâches.
const trayDots = (page) =>
  page.evaluate(() => window.__calls.filter((c) => c.cmd === "set_tray_badge").map((c) => c.args.unread));
const taskbarDots = (page) =>
  page.evaluate(() =>
    window.__calls.filter((c) => c.cmd === "plugin:window|set_overlay_icon").map((c) => c.args.value != null)
  );

// La fenêtre passe derrière une autre, sans aller dans le tray.
const blurWindow = (page) =>
  page.evaluate(() => {
    window.__win.focused = false;
    window.__emit("tauri://blur");
  });

// La fenêtre passe dans le tray.
const hideWindow = (page) =>
  page.evaluate(() => {
    Object.assign(window.__win, { visible: false, focused: false });
    window.__emit("tauri://blur");
  });

// La fenêtre revient du tray. Le webview ne voit pas d'évènement `focus` :
// `document.hasFocus()` était resté vrai pendant qu'elle était cachée.
const restoreWithoutDomFocus = (page) =>
  page.evaluate(() => {
    Object.assign(window.__win, { visible: true, focused: true });
    window.__emit("tauri://focus");
  });

// Variante : le webview voit le `focus`, avant que l'état natif ne soit à jour.
const restoreDomFocusFirst = async (page) => {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(60);
  await restoreWithoutDomFocus(page);
};

for (const [gesture, restore] of [
  ["sans évènement focus dans le webview", restoreWithoutDomFocus],
  ["focus du webview avant l'état natif", restoreDomFocusFirst],
]) {
  test(`desktop : revenir du tray marque la conversation lue (${gesture})`, async ({ request, browser }) => {
    const { alice, bob } = await accounts(request);
    const desktop = await openApp(browser, alice, { init: fakeTauri });
    const bobPage = await openApp(browser, bob);
    const unread = async () => (await channelOf(request, alice, "Général")).unread;

    await hideWindow(desktop);
    await say(bobPage, "premier non lu");
    await say(bobPage, "le suivant");
    await expect.poll(() => toasts(desktop)).toEqual(["premier non lu", "le suivant"]);
    expect(await unread()).toBe(true);

    await restore(desktop);
    await expect.poll(unread).toBe(false);

    // Rouverte, la conversation ne repart plus du premier message « non lu ».
    await openNotes(desktop);
    await openGeneral(desktop);
    await expect(desktop.getByRole("paragraph").filter({ hasText: "le suivant" })).toBeVisible();
    await expect(desktop.getByText("Nouveaux messages")).toHaveCount(0);

    await bobPage.context().close();
    await desktop.context().close();
  });
}

// Le webview reste « visible » dans le tray : ce signal relance une resynchro de la
// liste des conversations, sans que personne soit revenu sur la fenêtre.
async function resync(page) {
  const listed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/channels" && r.request().method() === "GET"
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await listed;
  await page.waitForTimeout(200);
}

for (const [situation, leave, back] of [
  ["dans le tray", hideWindow, restoreWithoutDomFocus],
  ["derrière une autre fenêtre", blurWindow, restoreDomFocusFirst],
]) {
  test(`desktop : un message dans la conversation ouverte, fenêtre ${situation}, allume le point jusqu'au retour`, async ({
    request,
    browser,
  }) => {
    const { alice, bob } = await accounts(request);
    const desktop = await openApp(browser, alice, { init: fakeTauri });
    const bobPage = await openApp(browser, bob);

    // Fenêtre au premier plan : aucun point, pas même un instant.
    await say(bobPage, "sous les yeux");
    await expect(desktop.getByRole("paragraph").filter({ hasText: "sous les yeux" })).toBeVisible();
    await desktop.waitForTimeout(300);
    expect(await trayDots(desktop)).not.toContain(true);
    expect(await taskbarDots(desktop)).not.toContain(true);

    await leave(desktop);
    await forgetCalls(desktop);
    await say(bobPage, "pendant l'absence");
    await expect.poll(() => trayDots(desktop)).toContain(true);
    await expect.poll(() => taskbarDots(desktop)).toContain(true);

    // La resynchro ne l'éteint pas : le serveur le dit non lu, et il l'est.
    await resync(desktop);
    expect(await trayDots(desktop)).not.toContain(false);
    expect(await taskbarDots(desktop)).not.toContain(false);

    await back(desktop);
    await expect.poll(async () => (await trayDots(desktop)).at(-1)).toBe(false);
    await expect.poll(async () => (await taskbarDots(desktop)).at(-1)).toBe(false);

    await bobPage.context().close();
    await desktop.context().close();
  });
}

test("desktop : une conversation lue retire ses toasts du centre de notifications", async ({
  request,
  browser,
}) => {
  const { alice, bob } = await accounts(request);
  const general = await channelOf(request, alice, "Général");
  const desktop = await openApp(browser, alice, { init: fakeTauri });
  const bobPage = await openApp(browser, bob);

  // Retour sur la fenêtre, conversation déjà ouverte.
  await hideWindow(desktop);
  await say(bobPage, "un");
  await expect.poll(() => toasts(desktop)).toHaveLength(1);
  await forgetCalls(desktop);
  await restoreWithoutDomFocus(desktop);
  await expect.poll(() => clearedChannels(desktop)).toContain(general.id);

  // Lue sur un autre appareil, la fenêtre restant dans le tray.
  await hideWindow(desktop);
  await say(bobPage, "deux");
  await expect.poll(() => toasts(desktop)).toHaveLength(1);
  await forgetCalls(desktop);
  const phone = await openApp(browser, alice);
  await expect.poll(() => clearedChannels(desktop)).toContain(general.id);
  await phone.context().close();

  // Ouverture depuis la barre latérale.
  await restoreWithoutDomFocus(desktop);
  await openNotes(desktop);
  await hideWindow(desktop);
  await say(bobPage, "trois");
  await expect.poll(() => toasts(desktop)).toHaveLength(1);
  await restoreWithoutDomFocus(desktop);
  await forgetCalls(desktop);
  await openGeneral(desktop);
  await expect.poll(() => clearedChannels(desktop)).toContain(general.id);

  await bobPage.context().close();
  await desktop.context().close();
});

// ── PWA : vrais évènements push dans le service worker ────────────────────

async function serviceWorker(page) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg?.active) return false;
        return !!(await (await caches.open("murgat-sw-config-v1")).match("/__api_base__"));
      })
    )
    .toBe(true);
  const cdp = await page.context().newCDPSession(page);
  const registrations = [];
  cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations: regs }) => {
    for (const r of regs) if (!r.isDeleted) registrations.push(r);
  });
  await cdp.send("ServiceWorker.enable");
  await expect.poll(() => registrations.length).toBeGreaterThan(0);
  const { registrationId } = registrations[registrations.length - 1];
  const origin = new URL(page.url()).origin;
  const shown = () =>
    page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return (await reg.getNotifications()).map((n) => ({
        tag: n.tag,
        body: n.body,
        silent: n.silent,
        data: n.data,
      }));
    });
  return {
    shown,
    push: (data) =>
      cdp.send("ServiceWorker.deliverPushMessage", {
        origin,
        registrationId,
        data: JSON.stringify({ title: "Bob", body: "message", ...data }),
      }),
    closeAll: async () => {
      await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.ready;
        for (const n of await reg.getNotifications()) n.close();
      });
      await expect.poll(shown).toEqual([]);
    },
    // L'URL de l'API que lit le service worker : la remplacer permet de simuler
    // un réseau lent sans toucher au vrai serveur.
    useApi: (url) =>
      page.evaluate(async (u) => {
        const cache = await caches.open("murgat-sw-config-v1");
        await cache.put("/__api_base__", new Response(u));
      }, url),
  };
}

// API de lecture qui met `delayMs` à répondre `read`.
async function slowApi(delayMs) {
  const api = { read: [false], bodies: [] };
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") return res.end();
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      api.bodies.push(JSON.parse(body));
      const read = api.read;
      setTimeout(() => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ read }));
      }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api.url = `http://127.0.0.1:${server.address().port}`;
  api.close = () => {
    server.closeAllConnections();
    server.close();
  };
  return api;
}

test("PWA : un push récent s'affiche sans attendre l'API, un push retenu attend sa réponse", async ({
  request,
  browser,
}) => {
  const { alice } = await accounts(request);
  const page = await openApp(browser, alice);
  const sw = await serviceWorker(page);
  const api = await slowApi(2000);
  await sw.useApi(api.url);
  const answered = () => page.waitForTimeout(2200);

  // Récent : affiché bien avant les 2 s de l'API, et le délai est remonté.
  const start = Date.now();
  await sw.push({ tag: "channel:A", channelId: "A", readToken: "tA", sentAt: Date.now() - 800 });
  await expect.poll(sw.shown, { intervals: [25], timeout: 5000 }).toHaveLength(1);
  expect(Date.now() - start).toBeLessThan(1500);
  await expect.poll(() => api.bodies.length).toBe(1);
  expect(api.bodies[0].pushDelayMs).toBeGreaterThanOrEqual(800);
  await answered();

  // La réponse arrivée après coup ferme ce qui a été lu entre-temps…
  api.read = [false, true];
  await sw.push({ tag: "channel:B", channelId: "B", readToken: "tB", sentAt: Date.now() });
  await expect.poll(async () => (await sw.shown()).map((n) => n.tag), { timeout: 4000 }).toEqual(["channel:B"]);
  await answered();

  // …sauf le nouveau message d'une conversation dont l'ancien était lu : même
  // tag, il a remplacé la notification lue et doit rester.
  await sw.push({ tag: "channel:B", channelId: "B", readToken: "tB2", body: "plus récent", sentAt: Date.now() });
  await answered();
  expect((await sw.shown()).map((n) => n.body)).toEqual(["plus récent"]);

  // Retenu une heure (Doze) et lu depuis : rien tant que l'API n'a pas répondu.
  await sw.closeAll();
  api.read = [true];
  await sw.push({ tag: "channel:C", channelId: "C", readToken: "tC", sentAt: Date.now() - 3_600_000 });
  await page.waitForTimeout(1200);
  expect(await sw.shown()).toEqual([]);
  await expect
    .poll(async () => (await sw.shown()).map((n) => ({ tag: n.tag, silent: n.silent })), { timeout: 4000 })
    .toEqual([{ tag: "channel:C", silent: true }]);

  api.close();
  await page.context().close();
});

test("PWA : rien pour la conversation ouverte au premier plan, une notification pour les autres", async ({
  request,
  browser,
}) => {
  const { alice } = await accounts(request);
  const general = await channelOf(request, alice, "Général");
  const page = await openApp(browser, alice);
  const sw = await serviceWorker(page);

  await sw.push({ tag: `channel:${general.id}`, channelId: general.id, readToken: "t", sentAt: Date.now() });
  await page.waitForTimeout(1200);
  expect(await sw.shown()).toEqual([]);

  await sw.push({ tag: "channel:autre", channelId: "autre", readToken: "t", sentAt: Date.now() });
  await expect.poll(async () => (await sw.shown()).map((n) => n.tag)).toEqual(["channel:autre"]);

  await page.context().close();
});

// App ouverte mais pas au premier plan : le message arrive par le socket ET par
// le web push, sous le même tag, avec `renotify`. Une seule alerte attendue.
const windowInBackground = () => {
  document.hasFocus = () => false;
};

// Fenêtre dont le test décide du focus, et compteur de l'icône de la PWA.
const pwaWindow = () => {
  window.__focused = true;
  window.__badges = [];
  document.hasFocus = () => window.__focused;
  navigator.setAppBadge = (n) => (window.__badges.push(n), Promise.resolve());
  navigator.clearAppBadge = () => (window.__badges.push(0), Promise.resolve());
};

test("PWA : un message dans la conversation ouverte, fenêtre sans le focus, compte jusqu'au retour", async ({
  request,
  browser,
}) => {
  const { alice, bob } = await accounts(request);
  const page = await openApp(browser, alice, { init: pwaWindow });
  const bobPage = await openApp(browser, bob);
  const badges = () => page.evaluate(() => window.__badges);
  const lastBadge = async () => (await badges()).at(-1);
  const setFocused = (focused) => page.evaluate((f) => (window.__focused = f), focused);

  // Fenêtre au premier plan : le compteur ne bouge pas, pas même un instant.
  await say(bobPage, "sous les yeux");
  await expect(page.getByRole("paragraph").filter({ hasText: "sous les yeux" })).toBeVisible();
  await page.waitForTimeout(300);
  expect((await badges()).filter(Boolean)).toEqual([]);

  // Retour par le focus de la fenêtre…
  await setFocused(false);
  await say(bobPage, "pendant l'absence");
  await expect.poll(lastBadge).toBe(1);
  await setFocused(true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(lastBadge).toBe(0);

  // …ou parce que l'onglet redevient visible.
  await setFocused(false);
  await say(bobPage, "encore absent");
  await expect.poll(lastBadge).toBe(1);
  await setFocused(true);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(lastBadge).toBe(0);

  await bobPage.context().close();
  await page.context().close();
});

test("PWA : un message reçu par le socket puis par le push n'alerte qu'une fois", async ({
  request,
  browser,
}) => {
  const { alice, bob } = await accounts(request);
  const general = await channelOf(request, alice, "Général");
  const page = await openApp(browser, alice, { init: windowInBackground });
  const bobPage = await openApp(browser, bob);
  const sw = await serviceWorker(page);
  await openNotes(page);

  await say(bobPage, "par le socket");
  await expect.poll(async () => (await sw.shown()).length).toBe(1);
  const [before] = await sw.shown();
  expect(before.data.messageId).toEqual(expect.any(String));

  await sw.push({
    tag: `channel:${general.id}`,
    channelId: general.id,
    readToken: "t",
    sentAt: Date.now(),
    messageId: before.data.messageId,
  });
  await page.waitForTimeout(1000);
  expect((await sw.shown()).map((n) => n.data.receivedAt)).toEqual([before.data.receivedAt]);

  await bobPage.context().close();
  await page.context().close();
});

test("PWA : un message reçu par le push puis par le socket n'alerte qu'une fois", async ({
  request,
  browser,
}) => {
  const { alice, bob } = await accounts(request);
  const general = await channelOf(request, alice, "Général");

  // On retient l'évènement `notification` : le push passe devant.
  const held = [];
  let toPage = null;
  const route = (page) =>
    page.routeWebSocket(/socket\.io/, (ws) => {
      toPage = ws;
      ws.connectToServer().onMessage((message) => {
        if (String(message).startsWith('42["notification"')) held.push(message);
        else ws.send(message);
      });
    });
  const page = await openApp(browser, alice, { init: windowInBackground, route });
  const bobPage = await openApp(browser, bob);
  const sw = await serviceWorker(page);
  await openNotes(page);

  await say(bobPage, "par le push");
  await expect.poll(() => held.length).toBe(1);
  const messageId = JSON.parse(held[0].slice(2))[1].message.id;

  await sw.push({
    tag: `channel:${general.id}`,
    channelId: general.id,
    readToken: "jeton-du-push",
    sentAt: Date.now(),
    messageId,
  });
  await expect.poll(async () => (await sw.shown()).length).toBe(1);

  toPage.send(held[0]);
  await page.waitForTimeout(1000);
  expect((await sw.shown()).map((n) => n.data.readToken)).toEqual(["jeton-du-push"]);

  await bobPage.context().close();
  await page.context().close();
});
