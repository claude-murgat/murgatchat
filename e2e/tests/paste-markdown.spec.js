import { test, expect } from "@playwright/test";

// Collage d'une liste à puces dans le composer. Chromium ne met pas les puces
// dans le texte brut du presse-papier (c'est le CSS qui les dessine) : une liste
// copiée depuis une réponse de Claude arrivait à plat, sans puces ni retraits,
// et perdait le gras et le code. Le composer relit maintenant le HTML copié et
// le traduit en Markdown (web/src/pasteMarkdown.ts).

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
const tag = () => `paste_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

// Virgin DB before each attempt (POST /test/reset gated par E2E_TEST_MODE ; un
// 404 — stack sans cette option — est toléré).
test.beforeEach(async ({ request }) => {
  const res = await request.post(`${API_URL.replace("localhost", "127.0.0.1")}/test/reset`);
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`/test/reset failed: HTTP ${res.status()}`);
  }
});

// Premier compte (DB vierge) : le serveur le bootstrap en admin et l'app ouvre
// #Général.
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
  const composer = page.getByPlaceholder("Message dans #Général");
  await expect(composer).toBeVisible();
  return composer;
}

const messageRow = (page, text) => page.locator("div.group").filter({ hasText: text }).last();

// La réponse de Claude que l'utilisateur a collée, telle qu'elle est rendue.
const CLAUDE_HTML = `<p>Il reste trois petites choses, sans impact sur les utilisateurs :</p>
<ul>
<li><strong>Une exécution en rouge sur GitHub Actions</strong> : c’est le run de la release.</li>
<li><strong>Deux limites connues, acceptées</strong> :
<ul>
<li>le badge « Désactivé » n’apparaît qu’au prochain rechargement de l’appli ;</li>
<li>une appli desktop en 1.6.1 affiche le code brut <code>target_disabled</code>.</li>
</ul>
</li>
<li><strong>Deux branches mergées</strong> : <code>claude/fix/a</code> et <code>claude/fix/b</code>.</li>
</ul>`;

const CLAUDE_MD = `Il reste trois petites choses, sans impact sur les utilisateurs :

- **Une exécution en rouge sur GitHub Actions** : c’est le run de la release.
- **Deux limites connues, acceptées** :
  - le badge « Désactivé » n’apparaît qu’au prochain rechargement de l’appli ;
  - une appli desktop en 1.6.1 affiche le code brut \`target_disabled\`.
- **Deux branches mergées** : \`claude/fix/a\` et \`claude/fix/b\`.`;

// Collage synthétique : renvoie true si le navigateur garde la main (collage
// natif), false si le composer l'a pris en charge.
function paste(field, html, text = "texte brut") {
  return field.evaluate(
    (el, { html, text }) => {
      el.focus();
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      if (html) dt.setData("text/html", html);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      return el.dispatchEvent(ev);
    },
    { html, text }
  );
}

test("liste copiée depuis une réponse rendue : puces, retraits, gras et code gardés", async ({
  page,
}) => {
  const composer = await bootstrapAdmin(page);

  // Vrai copier dans Chromium : on rend la réponse dans la page, on la
  // sélectionne et Ctrl+C, comme l'utilisateur depuis l'appli Claude.
  await page.evaluate((html) => {
    const div = document.createElement("div");
    div.id = "copy-source";
    div.innerHTML = html;
    document.body.appendChild(div);
    const range = document.createRange();
    range.selectNodeContents(div);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, CLAUDE_HTML);
  await page.keyboard.press("Control+C");
  // Le texte brut du presse-papier n'a ni puces ni retraits : c'était le bug.
  const plain = await page.evaluate(() => navigator.clipboard.readText());
  expect(plain).toContain("\nDeux limites connues, acceptées :\nle badge");
  await page.evaluate(() => document.getElementById("copy-source").remove());

  // Vrai collage (Ctrl+V) : le composer reçoit le Markdown.
  await composer.click();
  await page.keyboard.press("Control+V");
  await expect(composer).toHaveValue(CLAUDE_MD);

  // Ctrl+Z annule le collage d'un coup (historique natif conservé).
  await page.keyboard.press("Control+Z");
  await expect(composer).toHaveValue("");
  await page.keyboard.press("Control+V");
  await expect(composer).toHaveValue(CLAUDE_MD);

  // Envoyé, le message s'affiche en vraie liste imbriquée.
  await composer.press("Enter");
  const row = messageRow(page, "Il reste trois petites choses");
  await expect(row.locator(".md-body > ul > li")).toHaveCount(3);
  await expect(row.locator(".md-body > ul > li > ul > li")).toHaveCount(2);
  await expect(row.locator("strong")).toHaveCount(3);
  await expect(row.locator("code")).toHaveText(["target_disabled", "claude/fix/a", "claude/fix/b"]);
  // Sous-niveau en puces creuses, comme dans la réponse d'origine.
  const nested = row.locator(".md-body > ul > li > ul").first();
  await expect(nested).toHaveCSS("list-style-type", "circle");
});

test("Word, Google Docs, Gmail, tableaux et code ; collage natif sinon", async ({ page }) => {
  const composer = await bootstrapAdmin(page);

  async function expectPasted(html, expected) {
    await composer.fill("");
    expect(await paste(composer, html)).toBe(false);
    await expect(composer).toHaveValue(expected);
  }

  // Word / Outlook : pas de <ul>, des paragraphes « mso-list » avec une puce
  // dessinée en texte (Symbol « · », Courier « o », « 1. »).
  const word = (style, marker, text) =>
    `<p class=MsoListParagraph style='text-indent:-18.0pt;mso-list:${style}'><![if !supportLists]><span style='font-family:Symbol'><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>${text}<o:p></o:p></p>`;
  await expectPasted(
    `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><!--StartFragment-->` +
      `<p class=MsoNormal>Bonjour,<o:p></o:p></p><p class=MsoNormal><o:p>&nbsp;</o:p></p>` +
      word("l0 level1 lfo1", "·", "<b>Premier</b> point") +
      word("l0 level2 lfo1", "o", "Sous-point") +
      word("l0 level1 lfo1", "·", "Second point") +
      word("l1 level1 lfo2", "1.", "Un") +
      word("l1 level1 lfo2", "2.", "Deux") +
      `<!--EndFragment--></body></html>`,
    "Bonjour,\n\n- **Premier** point\n  - Sous-point\n- Second point\n\n1. Un\n2. Deux"
  );

  // Google Docs : tout est enveloppé dans un <b> NON gras, le gras est un
  // style, et la sous-liste est rangée à côté des <li>.
  await expectPasted(
    `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:400;white-space:pre-wrap;">Compte rendu</span></p><ul><li aria-level="1"><p role="presentation"><span style="font-weight:700;">Gras</span><span style="font-weight:400;"> puis normal</span></p></li><ul><li aria-level="2"><p role="presentation"><span style="font-style:italic;">Italique</span></p></li></ul></ul></b>`,
    "Compte rendu\n\n- **Gras** puis normal\n  - *Italique*"
  );

  // Gmail : lignes en <div>, ligne vide en <div><br></div>.
  await expectPasted(
    `<div dir="ltr"><div>Salut,</div><div><br></div><div>Les points :</div><ol><li>un</li><li>deux</li></ol><div>À+</div></div>`,
    "Salut,\n\nLes points :\n\n1. un\n2. deux\n\nÀ+"
  );

  // Tableau (Claude, Excel) → tableau Markdown ; bloc de code multiligne.
  await expectPasted(
    `<table><tr><th>Nom</th><th>Rôle</th></tr><tr><td>Alice</td><td><b>admin</b></td></tr></table>`,
    "| Nom | Rôle |\n| --- | --- |\n| Alice | **admin** |"
  );
  await expectPasted(
    `<pre><code class="language-bash">npm ci\nnpm test\n</code></pre>`,
    "```bash\nnpm ci\nnpm test\n```"
  );

  // Rien à traduire, ou un résultat sur une ligne : le navigateur colle le
  // texte brut lui-même (l'événement n'est pas annulé, le champ reste vide
  // puisqu'un collage synthétique n'insère rien).
  const nativeCases = [
    `<span style="font-weight: 400;">Juste du texte</span>`,
    // Quelques mots copiés dans un titre : Chromium les enveloppe dans <h2>.
    `<h2 style="font-weight: 700;">titre de sect</h2>`,
    // Un seul élément de liste copié en entier.
    `<ul><li><strong>Un</strong> seul élément</li></ul>`,
    // VS Code : du code coloré en white-space: pre, ici avec un thème qui met
    // les commentaires en italique (ni « * » ajouté, ni retrait perdu).
    `<div style="font-family: Consolas, monospace; white-space: pre;"><div><span style="color:#6a9955;font-style: italic;">// Calcule</span></div><div>    <span style="color: #569cd6;">return</span> a * b;</div></div>`,
    // Un document texte ouvert dans le navigateur : un <pre> nu.
    `<pre style="word-wrap: break-word; white-space: pre-wrap;">Bonjour à tous,\n\nLa réunion est <b>déplacée</b>.</pre>`,
  ];
  for (const html of nativeCases) {
    await composer.fill("");
    expect(await paste(composer, html)).toBe(true);
    await expect(composer).toHaveValue("");
  }

  // Dans un bloc ``` en cours de saisie, on veut le texte tel quel.
  await composer.fill("```\n");
  expect(await paste(composer, `<ul><li>a</li><li>b</li></ul>`)).toBe(true);
  await expect(composer).toHaveValue("```\n");
});

test("modification d'un message : le collage garde aussi la liste", async ({ page }) => {
  const composer = await bootstrapAdmin(page);
  await composer.fill("message à corriger");
  await composer.press("Enter");
  const row = messageRow(page, "message à corriger");
  await row.hover();
  await row.getByRole("button", { name: "Modifier" }).click();
  const editor = page.locator("textarea:focus");
  await editor.fill("");
  expect(await paste(editor, `<p>Corrigé :</p><ul><li>un</li><li>deux</li></ul>`)).toBe(false);
  await expect(editor).toHaveValue("Corrigé :\n\n- un\n- deux");
  await editor.press("Enter");
  const edited = messageRow(page, "Corrigé");
  await expect(edited.locator(".md-body > ul > li")).toHaveText(["un", "deux"]);
});

// Cas limites de la traduction, chacun collé dans le composer.
const EDGE_CASES = [
  ["liens (une adresse affichée telle quelle reste nue)",
    `<p>Voir <a href="https://example.com/doc">la doc</a> et <a href="https://example.com">https://example.com</a></p><p>Merci</p>`,
    "Voir [la doc](https://example.com/doc) et https://example.com\nMerci"],
  ["lien à parenthèses",
    `<p><a href="https://fr.wikipedia.org/wiki/Paris_(ville)">Paris</a></p><p>x</p>`,
    "[Paris](<https://fr.wikipedia.org/wiki/Paris_(ville)>)\nx"],
  ["Excel 2×2",
    `<table border=0><col width=64 span=2><tr height=20><td class=xl65>Ville</td><td class=xl65>Pop</td></tr><tr><td>Paris</td><td align=right>2100000</td></tr></table>`,
    "| Ville | Pop |\n| --- | --- |\n| Paris | 2100000 |"],
  ["tableau de mise en page (signature de mail, cellule fusionnée, logo) : son texte seulement",
    `<p>Voir <b>pièce jointe</b>.</p><table><tr><td rowspan=2><img src="logo.png" alt="Logo"></td><td><b>Jean Dupont</b></td></tr><tr><td>Directeur</td></tr></table>`,
    "Voir **pièce jointe**.\nLogo\n**Jean Dupont**\nDirecteur"],
  ["tableau avec légende et ligne masquée (Excel)",
    `<table><caption>Notes</caption><tr><td>Nom</td><td>Note</td></tr><tr style="display:none"><td>Caché</td><td>0</td></tr><tr><td>Alice</td><td>18</td></tr></table>`,
    "Notes\n\n| Nom | Note |\n| --- | --- |\n| Alice | 18 |"],
  ["liste numérotée qui commence à 3, imbriquée : séparée de son texte",
    `<ul><li>A<ol start="3"><li>trois</li><li>quatre</li></ol></li><li>B</li></ul>`,
    "- A\n\n  3. trois\n  4. quatre\n- B"],
  ["<br> dans un élément : saut forcé",
    `<ul><li>ligne 1<br>ligne 2</li><li>autre</li></ul>`,
    "- ligne 1  \n  ligne 2\n- autre"],
  ["liste aérée (<li><p>)",
    `<ul><li><p>Premier</p></li><li><p>Second</p><p>Suite</p></li></ul>`,
    "- Premier\n- Second\n\n  Suite"],
  ["citation",
    `<blockquote><p>Citation</p><p>sur deux lignes</p></blockquote><p>Réponse</p>`,
    "> Citation\n> sur deux lignes\n\nRéponse"],
  ["message MurgaChat recopié (paragraphe pre-wrap)",
    `<div class="md-body"><p style="white-space: pre-wrap;">Ligne 1\nLigne <strong>2</strong></p><ul>\n<li>a</li>\n<li>b</li>\n</ul></div>`,
    "Ligne 1\nLigne **2**\n\n- a\n- b"],
  ["texte des images (alt), comme le texte brut ; image décorative ignorée",
    `<p>Bravo <img alt="🎉" src="x.png"> <img alt=":partyparrot:"> <img src="s.gif" alt=""></p><ul><li>a</li><li>b</li></ul>`,
    "Bravo 🎉 :partyparrot:\n\n- a\n- b"],
  ["texte d'un bouton (question de FAQ, mention)",
    `<h2><button>Comment faire ?</button></h2><div><p><button>@Alice</button> clique sur <b>Oublié</b>.</p></div>`,
    "## Comment faire ?\n\n@Alice clique sur **Oublié**."],
  ["Word : libellés « c) » gardés, titre numéroté",
    `<h1 style='mso-list:l0 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>1<span>&nbsp;&nbsp; </span></span><![endif]>Introduction</h1>` +
      `<p class=MsoListParagraph style='mso-list:l3 level1 lfo4'><![if !supportLists]><span style='mso-list:Ignore'>c)<span>&nbsp; </span></span><![endif]>trois</p>` +
      `<p class=MsoListParagraph style='mso-list:l3 level1 lfo4'><![if !supportLists]><span style='mso-list:Ignore'>d)<span>&nbsp; </span></span><![endif]>quatre</p>`,
    "# 1 Introduction\n\n- c) trois\n- d) quatre"],
  ["mise en page CSS : blocs en span display:block, ligne flex",
    `<span style="display: block;">Alice — 01</span><span style="display: block;">Bob — 03</span><div style="display: flex; gap: 8px;"><span><b>Bob</b></span><span>10:45</span></div>`,
    "Alice — 01\nBob — 03\n**Bob**\n10:45"],
  ["Google Docs : un mot gras coupé en deux morceaux",
    `<p><span style="font-weight:700">Murga</span><span style="font-weight:700;color:#6b2c91">Chat</span> est prêt</p><p><code>a</code><code>b</code> collés</p>`,
    "**MurgaChat** est prêt\n`ab` collés"],
  ["gras collé à du texte : la ponctuation sort, le lien garde son gras",
    `<p><strong>Étape 1 :</strong>Installer</p><p><b><a href="https://a.b/x">lien</a></b>s</p>`,
    "**Étape 1** :Installer\n[**lien**](https://a.b/x)s"],
  ["signature « -- » : pas de titre souligné",
    `<p>Merci <b>beaucoup</b></p><p>Cordialement,</p><div>-- <br>Jean</div>`,
    "Merci **beaucoup**\nCordialement,\n\\--\nJean"],
  ["citation sans texte écartée",
    `<p>Voir <b>ci-dessous</b></p><blockquote><img src="x.png"></blockquote><p>Fin</p>`,
    "Voir **ci-dessous**\nFin"],
  ["<code> affiché en bloc",
    `<p>Config <b>prod</b> :</p><code style="display:block;white-space:pre">server {\n  listen 80;\n}</code>`,
    "Config **prod** :\n\n```\nserver {\n  listen 80;\n}\n```"],
  ["cases à cocher",
    `<ul><li><input type="checkbox" checked disabled> fait</li><li><input type="checkbox" disabled> à faire</li></ul>`,
    "- [x] fait\n- [ ] à faire"],
  ["filet",
    `<p>a</p><hr><p>b</p>`,
    "a\n\n---\n\nb"],
  ["gras, italique et barré sur plusieurs paragraphes",
    `<p>du<strong> gras </strong>et de l'<i>italique</i></p><p><del>vieux</del> nouveau</p>`,
    "du **gras** et de l'*italique*\n~~vieux~~ nouveau"],
  ["code contenant un accent grave",
    "<p>Tape <code>a`b</code></p><p>ok</p>",
    "Tape ``a`b``\nok"],
  ["titre puis liste",
    `<h2>Résumé</h2><ul><li>a</li><li>b</li></ul>`,
    "## Résumé\n\n- a\n- b"],
  ["Outlook : vrais <li> au style mso-list",
    `<ul type=disc><li class=MsoListParagraph style='mso-list:l0 level1 lfo1'>Un<o:p></o:p></li><li class=MsoListParagraph style='mso-list:l0 level1 lfo1'>Deux<o:p></o:p></li></ul>`,
    "- Un\n- Deux"],
];

test("cas limites de la traduction en Markdown", async ({ page }) => {
  const composer = await bootstrapAdmin(page);
  for (const [name, html, expected] of EDGE_CASES) {
    await composer.fill("");
    expect(await paste(composer, html), name).toBe(false);
    await expect(composer, name).toHaveValue(expected);
  }
  // Collage natif : une cellule Excel, une ligne de gras, des blancs, une liste vide.
  for (const html of [
    `<table><tr><td>42</td></tr></table>`,
    `<p>du <b>gras</b> ici</p>`,
    `<p>&nbsp;</p><div><br></div>`,
    `<ul><li></li></ul>`,
  ]) {
    await composer.fill("");
    expect(await paste(composer, html), html).toBe(true);
  }
});

test("collage au milieu d'un texte, dans un bloc de code, Markdown déjà écrit, gros collage", async ({
  page,
}) => {
  const composer = await bootstrapAdmin(page);
  const LIST = `<ul><li>un</li><li>deux</li></ul>`;

  // Collée en fin de ligne ou devant du texte, une liste reste une liste.
  await composer.fill("Regarde : ");
  expect(await paste(composer, LIST)).toBe(false);
  await expect(composer).toHaveValue("Regarde : \n\n- un\n- deux");
  await composer.fill("fin du message");
  await composer.evaluate((el) => el.setSelectionRange(0, 0));
  expect(await paste(composer, LIST)).toBe(false);
  await expect(composer).toHaveValue("- un\n- deux\n\nfin du message");

  // Dans un bloc de code ouvert (même cité, ou en ~~~), on colle tel quel ;
  // « ```npm ci``` » sur une ligne n'est que du code en ligne.
  for (const before of ["```\n", "> ```\n> ", "~~~\n", "1. étape\n\n    ```\n    "]) {
    await composer.fill(before);
    expect(await paste(composer, LIST), before).toBe(true);
  }
  await composer.fill("```npm ci``` puis :\n");
  expect(await paste(composer, LIST)).toBe(false);
  await expect(composer).toHaveValue("```npm ci``` puis :\n\n- un\n- deux");

  // Texte brut déjà en Markdown (bouton « Copier » d'une IA) : on le garde.
  await composer.fill("");
  expect(await paste(composer, `<ul><li><b>a</b></li><li>b</li></ul>`, "- **a**\n- b")).toBe(true);

  // 3 000 éléments : le collage ne gèle pas l'onglet (2,6 s pour 1 500 avant).
  await composer.fill("");
  const big = await composer.evaluate((el) => {
    let html = "<p>Intro</p><ul>";
    for (let i = 0; i < 3000; i++) html += `<li><strong>Point ${i}</strong> : <code>x${i}</code></li>`;
    html += "</ul>";
    const dt = new DataTransfer();
    dt.setData("text/plain", "brut");
    dt.setData("text/html", html);
    el.focus();
    const t0 = performance.now();
    const native = el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
    );
    return { native, ms: performance.now() - t0, lines: el.value.split("\n").length };
  });
  expect(big.native).toBe(false);
  expect(big.lines).toBe(3002);
  expect(big.ms).toBeLessThan(1000);
});
