import { test, expect } from "@playwright/test";
import crypto from "node:crypto";

// Notifications de messages déjà lus sur un autre appareil.
//
// Android retient souvent un push jusqu'au déverrouillage (Doze) : il s'affichait
// alors pour un message lu depuis longtemps sur le PC. Le service worker demande
// désormais au serveur, à l'arrivée du push, si le message a été lu entre-temps
// (jeton de lecture signé → POST /auth/web-push/read-state), n'affiche pas ce qui
// est déjà lu et ferme les notifications devenues caduques — sans jamais laisser
// un push sans notification visible (exigence de Chrome et Safari). L'app, elle,
// ferme les notifications des conversations qu'elle sait lues.
//
// On injecte de VRAIS évènements `push` dans le service worker via le protocole
// DevTools (ServiceWorker.deliverPushMessage), avec des jetons signés comme le
// fait le serveur (server/src/pushReadToken.ts, clé dérivée du JWT_SECRET du
// stack e2e).
test.use({ channel: "chromium", permissions: ["notifications"] });

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
const JWT_SECRET = process.env.E2E_JWT_SECRET || "e2e-secret";
const tag = () => `prs_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

test.beforeEach(async ({ request }) => {
  const res = await request.post(`${API_URL.replace("localhost", "127.0.0.1")}/test/reset`);
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`/test/reset failed: HTTP ${res.status()}`);
  }
});

// Même format que signReadToken (server/src/pushReadToken.ts).
function readToken(userId, channelId, createdAt) {
  const key = crypto.createHash("sha256").update(`murgat-push-read:${JWT_SECRET}`).digest();
  const body = Buffer.from(`${userId}.${channelId}.${createdAt}`).toString("base64url");
  const sig = crypto.createHmac("sha256", key).update(body).digest("base64url").slice(0, 22);
  return `${body}.${sig}`;
}

async function bootstrapAdmin(page) {
  const t = tag();
  await page.goto("/");
  const server = page.getByPlaceholder(/Adresse du serveur/);
  await expect(server).toBeVisible();
  await server.fill(API_URL);
  await page.getByRole("button", { name: "Tester" }).click();
  await expect(page.getByText(/joignable/)).toBeVisible();
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
  await expect(page.getByRole("button", { name: /Général/ }).first()).toBeVisible();
}

// Notifications affichées par l'application (celles du service worker).
const shown = (page) =>
  page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.getNotifications()).map((n) => ({ tag: n.tag, silent: n.silent }));
  });
// Ferme tout, puis attend que la fermeture soit effective : le service worker
// lit la même liste, et un push injecté trop tôt y verrait encore l'ancienne.
async function closeAll(page) {
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    for (const n of await reg.getNotifications()) n.close();
  });
  await expect.poll(() => shown(page)).toEqual([]);
}

test("un push de message déjà lu ailleurs ne s'affiche pas, et efface les notifications lues", async ({
  page,
  request,
  browser,
}) => {
  await bootstrapAdmin(page);

  // Identité et salon réels : le serveur vérifie l'appartenance du jeton.
  const token = await page.evaluate(() => localStorage.getItem("chat_token"));
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const api = API_URL.replace("localhost", "127.0.0.1");
  const me = (await (await request.get(`${api}/auth/me`, auth)).json()).user;
  const { channels } = await (await request.get(`${api}/channels`, auth)).json();
  const general = channels.find((c) => c.name === "Général");
  expect(general).toBeTruthy();
  // Non lu : message daté de demain (lastReadAt ne peut pas le rattraper).
  const UNREAD = readToken(me.id, general.id, Date.now() + 86_400_000);
  // Lu : salon dont l'utilisateur n'est pas membre → « rien à montrer ».
  const READ = readToken(me.id, "salonquilnexistepas", 0);

  // Service worker actif et URL de l'API déposée pour lui (cf. pwa.ts).
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
  const push = (data) =>
    cdp.send("ServiceWorker.deliverPushMessage", {
      origin,
      registrationId,
      data: JSON.stringify({ title: "Quelqu'un", body: "message", ...data }),
    });

  // 1) Message non lu : affiché normalement.
  await push({ tag: "channel:A", channelId: "A", readToken: UNREAD });
  await expect.poll(() => shown(page)).toEqual([{ tag: "channel:A", silent: false }]);

  // 2) Message déjà lu ailleurs, une notification non lue reste : rien d'affiché.
  await push({ tag: "channel:B", channelId: "B", readToken: READ });
  await page.waitForTimeout(1500);
  expect(await shown(page)).toEqual([{ tag: "channel:A", silent: false }]);

  // 3) Message déjà lu et plus rien d'affiché : il faut bien montrer quelque
  //    chose (Chrome / Safari), mais sans son ni vibration.
  await closeAll(page);
  await push({ tag: "channel:C", channelId: "C", readToken: READ });
  await expect.poll(() => shown(page)).toEqual([{ tag: "channel:C", silent: true }]);

  // 4) Nouveau message non lu : affiché, et la notification déjà lue est fermée.
  await push({ tag: "channel:D", channelId: "D", readToken: UNREAD });
  await expect.poll(() => shown(page)).toEqual([{ tag: "channel:D", silent: false }]);

  // 5) L'app ferme les notifications d'une conversation dès qu'on l'ouvre. Il
  //    faut un VRAI message non lu dans #Général — d'un autre membre — sans quoi
  //    une resynchro de la liste des salons fermerait la notification à raison.
  //    On quitte d'abord #Général pour « Mes notes » (créée via la recherche).
  await closeAll(page);
  page.on("dialog", (d) => d.accept());
  await page.getByPlaceholder(/Rechercher ou créer/).fill("notes");
  await page.getByRole("button", { name: /Mes notes \(conversation avec soi-même\)/ }).click();
  await expect(page.getByPlaceholder(/^Message à /)).toBeVisible();
  await expect(page.getByPlaceholder("Message dans #Général")).toHaveCount(0);

  // Un second membre (invitation → inscription) écrit dans #Général.
  const t2 = tag();
  const invite = await (
    await request.post(`${api}/auth/invitations`, { ...auth, data: { email: `${t2}@e2e.local` } })
  ).json();
  const reg2 = await (
    await request.post(`${api}/auth/register`, {
      data: {
        email: `${t2}@e2e.local`,
        username: t2,
        displayName: `Collègue ${t2}`,
        password: "test1234",
        token: invite.token,
      },
    })
  ).json();
  expect(reg2.token).toEqual(expect.any(String));
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.addInitScript(
    ([base, jwt]) => {
      try {
        localStorage.setItem("chat_api_base", base);
        localStorage.setItem("chat_token", jwt);
      } catch {
        /* about:blank : réessayé au vrai document */
      }
    },
    [API_URL, reg2.token]
  );
  await page2.goto(new URL("/", page.url()).href);
  const composer2 = page2.getByPlaceholder("Message dans #Général");
  await expect(composer2).toBeVisible();
  const text = `lu nulle part ${t2}`;
  await composer2.fill(text);
  await composer2.press("Enter");
  await expect(page2.getByText(text)).toBeVisible();
  await ctx2.close();

  // Son push arrive sur l'appareil de l'admin : non lu, il s'affiche et reste.
  const msgs = await (await request.get(`${api}/channels/${general.id}/messages`, auth)).json();
  const sentMsg = msgs.messages.find((m) => m.body === text);
  expect(sentMsg).toBeTruthy();
  await expect
    .poll(async () => (await (await request.get(`${api}/channels`, auth)).json()).channels.find((c) => c.id === general.id).unread)
    .toBe(true);
  const fresh = readToken(me.id, general.id, new Date(sentMsg.createdAt).getTime());
  await push({ tag: `channel:${general.id}`, channelId: general.id, readToken: fresh });
  await expect.poll(() => shown(page)).toEqual([{ tag: `channel:${general.id}`, silent: false }]);

  // Ouvrir #Général : sa notification disparaît.
  await page.getByRole("button", { name: /Général/ }).first().click();
  await expect.poll(() => shown(page)).toEqual([]);
});
