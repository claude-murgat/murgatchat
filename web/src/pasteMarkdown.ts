// Collage riche → Markdown dans les champs de saisie des messages.
//
// Les messages sont du Markdown, rendu en GFM à l'affichage (MessageMarkdown).
// Mais un <textarea> ne reçoit au collage que le texte brut du presse-papier, et
// Chromium (donc aussi WebView2 dans l'appli de bureau) n'y met pas les puces
// d'une liste : c'est le CSS qui les dessine. Une liste copiée depuis une réponse
// de Claude, un Google Docs, Word ou un mail arrivait donc à plat, sans puces ni
// retrait, et perdait au passage le gras et le code.
//
// Au collage, on relit la version HTML du presse-papier et on la traduit en
// Markdown : listes (imbriquées, numérotées, y compris les fausses listes de
// Word), gras, italique, barré, code, liens, titres, citations, blocs de code et
// tableaux. On laisse faire le collage natif, comme avant :
//  - quand le HTML n'apporte aucune mise en forme ;
//  - quand le résultat tient sur une ligne : quelques mots copiés dans un titre
//    ou un élément de liste restent du texte, sans « ## » ni « - » ;
//  - quand on ne colle que du code (VS Code, un <pre>) : il arrive tel quel ;
//  - quand le texte brut est déjà du Markdown (bouton « Copier » d'une IA) ;
//  - dans un bloc ``` en cours de saisie, et au Ctrl+Maj+V.
import type { ClipboardEvent } from "react";

type Space = "normal" | "pre-line" | "pre";

/** Contexte hérité pendant le parcours du HTML collé. */
interface Ctx {
  space: Space;
  mono: boolean;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  href: string | null;
}

/** Morceau de texte d'une ligne, avec sa mise en forme. */
interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  href: string | null;
}

type Line = Run[];

interface ListBlock {
  kind: "list";
  ordered: boolean;
  start: number;
  items: Block[][];
}

interface CodeBlock {
  kind: "code";
  text: string;
  lang: string;
  // <pre><code>, classe language-… : un vrai bloc de code. Sinon (<pre> nu,
  // texte à chasse fixe de VS Code), seul, il est laissé au collage natif.
  explicit: boolean;
}

type Block =
  | { kind: "para"; lines: Line[] }
  // Ligne vide voulue (paragraphe vide de Word, <div><br></div> de Gmail…).
  | { kind: "blank" }
  | { kind: "heading"; level: number; line: Line }
  | ListBlock
  | { kind: "quote"; blocks: Block[] }
  | CodeBlock
  | { kind: "table"; rows: Line[][] }
  | { kind: "rule" };

const ROOT: Ctx = {
  space: "normal",
  mono: false,
  bold: false,
  italic: false,
  strike: false,
  code: false,
  href: null,
};

// Au-delà, on laisse le collage natif (page entière collée, HTML pathologique).
const MAX_HTML = 5_000_000;

// Éléments dont le contenu n'est pas du texte à coller (formulaires, médias…).
// <img> et <input> sont traités à part ; un <button> garde son texte (question
// d'une FAQ, mention), sauf dans la barre d'un bloc de code (« Copier »).
const SKIP = new Set([
  "head", "title", "meta", "link", "style", "script", "template", "noscript",
  "select", "option", "textarea", "svg", "math", "canvas", "video", "audio",
  "iframe", "object", "embed", "picture", "source", "map", "area",
]);

const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center",
  "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "html", "li", "main", "menu", "nav", "ol", "p",
  "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead",
  "tr", "ul",
]);

const PRE_TAGS = new Set(["pre", "listing", "xmp", "plaintext"]);
const CODE_TAGS = new Set(["code", "kbd", "samp", "tt"]);
const MONO =
  /mono|consolas|courier|menlo|monaco|lucida console|inconsolata|cascadia|fira code|jetbrains|source code|\bhack\b/i;

// Paragraphe d'une liste Word/Outlook : Word n'écrit pas de <ul>/<li> mais des
// <p style="mso-list:l0 level2 lfo1">, la puce étant un <span mso-list:Ignore>.
const WORD_LIST = /mso-list:\s*(l\d+)\s+level(\d+)/i;

const BREAK: Run = { text: "\n", bold: false, italic: false, strike: false, code: false, href: null };

/** Valeur d'une propriété du style en ligne (la dernière déclarée, comme en CSS). */
function styleOf(el: Element, prop: string): string | undefined {
  const style = el.getAttribute("style");
  if (!style) return undefined;
  const all = Array.from(style.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "gi")));
  return all.at(-1)?.[1].replace(/!important/i, "").trim().toLowerCase();
}

function skipped(el: Element): boolean {
  const tag = el.localName;
  if (SKIP.has(tag) || el.hasAttribute("hidden")) return true;
  // Retour à la ligne que Chromium et WebKit ajoutent en bord de sélection.
  if (tag === "br" && el.classList.contains("Apple-interchange-newline")) return true;
  if (tag === "button" && codeToolbar(el)) return true;
  const style = el.getAttribute("style");
  return (
    !!style &&
    (styleOf(el, "display") === "none" || /mso-list\s*:\s*ignore|mso-hide\s*:\s*all/i.test(style))
  );
}

/** Bouton de la barre d'un bloc de code (« Copier ») : à côté d'un <pre>. */
function codeToolbar(button: Element): boolean {
  let up = button.parentElement;
  for (let i = 0; up && i < 3; i++, up = up.parentElement) {
    if (up.localName === "pre" || up.querySelector("pre")) return true;
  }
  return false;
}

function whiteSpace(el: Element, inherited: Space): Space {
  if (PRE_TAGS.has(el.localName)) return "pre";
  const collapse = styleOf(el, "white-space-collapse");
  if (collapse === "preserve" || collapse === "break-spaces") return "pre";
  if (collapse === "preserve-breaks") return "pre-line";
  if (collapse === "collapse") return "normal";
  const ws = styleOf(el, "white-space");
  if (!ws) return inherited;
  if (ws.startsWith("pre-line")) return "pre-line";
  if (ws.startsWith("pre") || ws === "break-spaces") return "pre";
  if (ws === "normal" || ws === "nowrap") return "normal";
  return inherited;
}

function collapse(text: string, space: Space): string {
  if (space === "pre") return text.replace(/\r\n?/g, "\n");
  if (space === "pre-line") return text.replace(/\r\n?/g, "\n").replace(/[ \t\f]+/g, " ");
  return text.replace(/[ \t\n\r\f]+/g, " ");
}

/** Rendu en bloc : le `display` du style en ligne prime sur la balise. */
function isBlockLevel(el: Element, flexItem: boolean): boolean {
  const display = styleOf(el, "display");
  if (display) {
    return !(display === "contents" || display.startsWith("inline") || display.startsWith("ruby"));
  }
  return flexItem || BLOCKS.has(el.localName);
}

function isFlex(el: Element): boolean {
  return /^(flex|grid|-webkit-box)$/.test(styleOf(el, "display") ?? "");
}

function isBold(el: Element): boolean {
  const weight = styleOf(el, "font-weight");
  const n = Number(weight);
  // Google Docs enveloppe tout le collage dans <b style="font-weight:normal">.
  if (el.localName === "b" || el.localName === "strong") {
    return !(weight === "normal" || weight === "lighter" || (n > 0 && n < 500));
  }
  return weight === "bold" || weight === "bolder" || n >= 700;
}

function isItalic(el: Element): boolean {
  const style = styleOf(el, "font-style");
  if (el.localName === "i" || el.localName === "em") return style !== "normal";
  return style === "italic" || style === "oblique";
}

function isStruck(el: Element): boolean {
  const deco = styleOf(el, "text-decoration-line") ?? styleOf(el, "text-decoration");
  if (["s", "strike", "del"].includes(el.localName)) return !deco?.includes("none");
  return !!deco?.includes("line-through");
}

function linkHref(el: Element): string | null {
  const href = (el.getAttribute("href") ?? "").trim();
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
}

/** Texte d'une image : son alt, comme le texte brut de Chromium (sauf décor). */
function altText(el: Element): string {
  const role = el.getAttribute("role");
  return role === "presentation" || role === "none" ? "" : (el.getAttribute("alt") ?? "");
}

/** Texte d'un bloc de code : sauts de ligne du texte, des <br> et des blocs. */
function preText(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.nodeValue ?? "";
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (skipped(el)) continue;
      if (el.localName === "br") {
        out += "\n";
        continue;
      }
      const block = isBlockLevel(el, false);
      if (block && out && !out.endsWith("\n")) out += "\n";
      out += preText(el);
      if (block && !out.endsWith("\n")) out += "\n";
    }
  }
  return out.replace(/\r\n?/g, "\n");
}

function sameStyle(a: Run, b: Run): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strike === b.strike &&
    a.code === b.code &&
    a.href === b.href
  );
}

/**
 * Nettoie une ligne comme l'affichage : blancs consécutifs réduits, rien en
 * bord de ligne, espaces insécables rendus normaux, morceaux de même style
 * fusionnés (Google Docs coupe un mot gras à chaque changement de couleur).
 */
function cleanLine(line: Line): Line {
  const pieces: Run[] = [];
  for (const run of line) {
    if (!run.code) {
      pieces.push(run);
      continue;
    }
    // Les espaces au bord d'un bout de code restent hors du code.
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(run.text)!;
    const plain = { ...run, code: false, bold: false, italic: false, strike: false };
    if (m[1]) pieces.push({ ...plain, text: " " });
    if (m[2]) pieces.push({ ...run, text: m[2].replace(/\s+/g, " ") });
    if (m[3]) pieces.push({ ...plain, text: " " });
  }
  const out: Run[] = [];
  for (const run of pieces) {
    let text = run.text.replace(/[ \t\f\r]+/g, " ");
    const prev = out.at(-1);
    if (text.startsWith(" ") && (!prev || prev.text.endsWith(" "))) text = text.slice(1);
    if (!text) continue;
    if (prev && sameStyle(prev, run)) prev.text += text;
    else out.push({ ...run, text });
  }
  while (out.length && /^[ \u00a0]/.test(out[0].text)) {
    out[0].text = out[0].text.replace(/^[ \u00a0]+/, "");
    if (!out[0].text) out.shift();
  }
  while (out.length && /[ \u00a0]$/.test(out.at(-1)!.text)) {
    out.at(-1)!.text = out.at(-1)!.text.replace(/[ \u00a0]+$/, "");
    if (!out.at(-1)!.text) out.pop();
  }
  for (const run of out) run.text = run.text.replace(/\u00a0/g, " ");
  return out;
}

/** Accumule les morceaux de texte d'un paragraphe et la suite des blocs produits. */
class Sink {
  blocks: Block[] = [];
  private runs: Run[] = [];

  text(text: string, ctx: Ctx) {
    const { bold, italic, strike, code, href } = ctx;
    // Les sauts de ligne gardés (pre-wrap, pre-line) sont des sauts de ligne.
    text.split("\n").forEach((part, i) => {
      if (i) this.runs.push(code ? { ...BREAK, text: " ", code, href } : BREAK);
      if (part) this.runs.push({ text: part, bold, italic, strike, code, href });
    });
  }

  br() {
    this.runs.push(BREAK);
  }

  push(block: Block) {
    this.flush();
    this.blocks.push(block);
  }

  flush() {
    const runs = this.runs;
    this.runs = [];
    if (!runs.length) return;
    const lines: Line[] = [[]];
    for (const run of runs) {
      if (run === BREAK) lines.push([]);
      else lines.at(-1)!.push(run);
    }
    // Comme à l'écran : pas de ligne vide en bord de paragraphe (un <br> final
    // ne crée pas de ligne), et jamais plus d'une ligne vide d'affilée.
    const kept: Line[] = [];
    for (const line of lines.map(cleanLine)) {
      if (!line.length && !kept.at(-1)?.length) continue;
      kept.push(line);
    }
    while (kept.length && !kept.at(-1)!.length) kept.pop();
    if (kept.length) this.blocks.push({ kind: "para", lines: kept });
    else if (runs.some((r) => r === BREAK || r.text.includes("\u00a0")))
      this.blocks.push({ kind: "blank" });
  }
}

/** Fusionne les lignes des paragraphes d'une suite de blocs en une seule ligne. */
function flatLine(blocks: Block[]): Line {
  const out: Line = [];
  const space = { ...BREAK, text: " " };
  for (const b of blocks) {
    if (b.kind !== "para") continue;
    for (const line of b.lines) {
      if (out.length && line.length) out.push(space);
      out.push(...line);
    }
  }
  return cleanLine(out);
}

function plainText(line: Line): string {
  return line.map((r) => r.text).join("");
}

/**
 * Dernière passe sur une suite de blocs : les lignes de code consécutives
 * (une par <div> chez VS Code ou dans un diff) forment un seul bloc, et
 * l'étiquette de langage posée juste au-dessus d'un bloc de code disparaît.
 */
function tidy(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const prev = out.at(-1);
    if (
      b.kind === "code" &&
      prev?.kind === "code" &&
      !b.explicit &&
      !prev.explicit &&
      prev.lang === b.lang
    ) {
      out[out.length - 1] = { ...prev, text: `${prev.text}\n${b.text}` };
      continue;
    }
    out.push(b);
  }
  return out.filter((b, i) => {
    if (b.kind === "code") return !!b.text.trim();
    if (b.kind === "list") return b.items.length > 0;
    if (b.kind === "quote") return b.blocks.some((x) => x.kind !== "blank");
    if (b.kind === "heading") return b.line.length > 0;
    const next = out[i + 1];
    return !(
      b.kind === "para" &&
      next?.kind === "code" &&
      next.lang &&
      b.lines.length === 1 &&
      plainText(b.lines[0]).trim().toLowerCase() === next.lang.toLowerCase()
    );
  });
}

class Converter {
  blocks(node: Node, ctx: Ctx, flexItems = false): Block[] {
    const sink = new Sink();
    this.children(node, ctx, sink, flexItems);
    sink.flush();
    return tidy(sink.blocks);
  }

  private children(parent: Node, ctx: Ctx, sink: Sink, flexItems: boolean) {
    const kids = Array.from(parent.childNodes);
    for (let i = 0; i < kids.length; i++) {
      if (!wordList(kids[i])) {
        this.node(kids[i], ctx, sink, flexItems);
        continue;
      }
      // Paragraphes de liste Word consécutifs (blancs et commentaires
      // conditionnels entre eux ignorés) : ils forment une seule liste.
      const run: Element[] = [];
      while (i < kids.length && (wordList(kids[i]) || isBlankNode(kids[i]))) {
        if (wordList(kids[i])) run.push(kids[i] as Element);
        i++;
      }
      i--;
      for (const list of this.wordLists(run, ctx)) sink.push(list);
    }
  }

  private node(node: Node, ctx: Ctx, sink: Sink, flexItem: boolean) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = collapse(node.nodeValue ?? "", ctx.space);
      // Du texte posé directement dans une boîte flex en est un élément à part.
      const own = flexItem && !!text.trim();
      if (own) sink.flush();
      sink.text(text, ctx);
      if (own) sink.flush();
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (skipped(el)) return;
    const tag = el.localName;
    if (tag === "br") {
      if (ctx.code) sink.text(" ", ctx);
      else sink.br();
      return;
    }
    if (tag === "img") {
      sink.text(altText(el), ctx);
      return;
    }
    if (tag === "input") {
      if (el.getAttribute("type")?.toLowerCase() === "checkbox")
        sink.text(el.hasAttribute("checked") ? "[x] " : "[ ] ", ctx);
      return;
    }
    const inner = this.inherit(el, ctx);
    const block = isBlockLevel(el, flexItem);
    if ((tag === "ul" || tag === "ol") && !inlineItems(el)) {
      sink.push(this.list(el, inner));
      return;
    }
    if (tag === "li" && block) {
      // <li> hors liste : on lui rend sa puce.
      sink.push({ kind: "list", ordered: false, start: 1, items: [this.blocks(el, inner)] });
      return;
    }
    if (isCode(el, inner, block)) {
      sink.push(this.code(el));
      return;
    }
    if (tag === "blockquote") {
      sink.push({ kind: "quote", blocks: this.blocks(el, inner) });
      return;
    }
    if (tag === "hr") {
      sink.push({ kind: "rule" });
      return;
    }
    if (tag === "table" && block) {
      this.table(el, inner, sink);
      return;
    }
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      // Un titre est déjà gras : pas de « ** » en plus.
      const line = flatLine(this.blocks(el, inner)).map((r) => ({ ...r, bold: false }));
      // Titre numéroté de Word : on garde son numéro (« 1.1 Périmètre »).
      const label = wordMarker(el);
      if (label && line.length) line.unshift({ ...BREAK, text: `${label} ` });
      sink.push({ kind: "heading", level: Number(heading[1]), line });
      return;
    }
    if (block) {
      sink.flush();
      this.children(el, inner, sink, isFlex(el));
      sink.flush();
      return;
    }
    // En ligne : la mise en forme passe aux morceaux de texte qu'il contient.
    // Dans une boîte inline-flex (icône + libellé), une espace entre les éléments.
    if (/^inline-(flex|grid)$/.test(styleOf(el, "display") ?? "")) {
      Array.from(el.childNodes).forEach((child, i) => {
        if (i) sink.text(" ", inner);
        this.node(child, inner, sink, false);
      });
      return;
    }
    this.children(el, inner, sink, false);
  }

  private inherit(el: Element, ctx: Ctx): Ctx {
    const tag = el.localName;
    const family = styleOf(el, "font-family");
    const next: Ctx = {
      ...ctx,
      space: whiteSpace(el, ctx.space),
      mono: family === undefined ? ctx.mono : MONO.test(family),
    };
    if (CODE_TAGS.has(tag)) next.code = true;
    if (!next.code) {
      next.bold ||= isBold(el);
      next.italic ||= isItalic(el);
      next.strike ||= isStruck(el);
    }
    if (tag === "a") next.href = linkHref(el) ?? next.href;
    return next;
  }

  private list(el: Element, ctx: Ctx): ListBlock {
    const ordered = el.localName === "ol";
    const start = Number.parseInt(el.getAttribute("start") ?? "", 10);
    const items: Block[][] = [];
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE && (child as Element).localName === "li") {
        if (!skipped(child as Element))
          items.push(this.blocks(child, this.inherit(child as Element, ctx)));
        continue;
      }
      // Google Docs range la sous-liste à côté des <li>, pas dedans : on la
      // rattache à l'élément qui la précède.
      const sink = new Sink();
      this.node(child, ctx, sink, false);
      sink.flush();
      const extra = tidy(sink.blocks);
      if (!extra.length) continue;
      if (items.length) items[items.length - 1].push(...extra);
      else items.push(extra);
    }
    return {
      kind: "list",
      ordered,
      start: ordered && Number.isFinite(start) ? start : 1,
      items: items.filter((item) => item.some((b) => b.kind !== "blank")),
    };
  }

  private wordLists(run: Element[], ctx: Ctx): ListBlock[] {
    const roots: ListBlock[] = [];
    const stack: { list: ListBlock; level: number; id: string }[] = [];
    for (const p of run) {
      const { id, level } = wordList(p)!;
      const marker = wordMarker(p);
      // Une puce est un seul signe (« · », « o », « § ») ; « 3. » ou « 3) »
      // numérotent ; tout autre libellé (« c) », « 1.1 », « Article 2 - »)
      // reste écrit en tête de l'élément, dans une liste à puces.
      const number = /^\(?(\d+)[.)]$/.exec(marker);
      const label = !number && (marker.length > 1 || /\d/.test(marker)) ? marker : "";
      const ordered = !!number;
      while (stack.length && stack[stack.length - 1].level > level) stack.pop();
      // Au même niveau, une autre liste Word (lN) ou un autre type de puce
      // ouvre une nouvelle liste.
      const same = stack[stack.length - 1];
      if (same?.level === level && (same.id !== id || same.list.ordered !== ordered)) stack.pop();
      let top = stack[stack.length - 1];
      if (!top || top.level < level) {
        const list: ListBlock = {
          kind: "list",
          ordered,
          start: number ? Number(number[1]) : 1,
          items: [],
        };
        if (top) top.list.items[top.list.items.length - 1].push(list);
        else roots.push(list);
        top = { list, level, id };
        stack.push(top);
      }
      const item = this.blocks(p, this.inherit(p, ctx));
      if (label) {
        const first = item[0];
        const run = { ...BREAK, text: `${label} ` };
        if (first?.kind === "para") first.lines[0].unshift(run);
        else item.unshift({ kind: "para", lines: [[{ ...run, text: label }]] });
      }
      top.list.items.push(item);
    }
    return roots;
  }

  private code(el: Element): CodeBlock {
    const text = preText(el).replace(/\u00a0/g, " ").replace(/^\n+|\s+$/g, "");
    const code = el.localName === "code" ? el : el.querySelector("code");
    const classes = `${el.getAttribute("class") ?? ""} ${code?.getAttribute("class") ?? ""}`;
    const lang = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(classes)?.[1] ?? "";
    return { kind: "code", text, lang, explicit: !!code || !!lang };
  }

  private table(el: Element, ctx: Ctx, sink: Sink) {
    const caption = Array.from(el.children).find((c) => c.localName === "caption");
    if (caption && !skipped(caption))
      for (const b of this.blocks(caption, this.inherit(caption, ctx))) sink.push(b);
    // Grille des cellules, cellules fusionnées (rowspan/colspan) dépliées.
    const rows = Array.from((el as HTMLTableElement).rows).filter((r) => !skipped(r));
    const grid: (Block[] | null)[][] = rows.map(() => []);
    rows.forEach((row, r) => {
      let c = 0;
      for (const cell of Array.from(row.cells)) {
        if (skipped(cell)) continue;
        while (grid[r][c] !== undefined) c++;
        // Une cellule peut être elle-même du code (diff GitHub : td en chasse fixe).
        const cellCtx = this.inherit(cell, this.inherit(row, ctx));
        const blocks = isCode(cell, cellCtx, true) ? [this.code(cell)] : this.blocks(cell, cellCtx);
        const rowSpan = Math.min(Math.max(Number(cell.getAttribute("rowspan")) || 1, 1), rows.length - r);
        const colSpan = Math.min(Math.max(Number(cell.getAttribute("colspan")) || 1, 1), 100);
        for (let i = 0; i < rowSpan; i++)
          for (let j = 0; j < colSpan; j++) grid[r + i][c + j] = i || j ? null : blocks;
        c += colSpan;
      }
    });
    const cells = grid.map((row) =>
      Array.from(row, (blocks) => {
        const content = (blocks ?? []).filter((b) => b.kind !== "blank");
        return {
          simple: content.length <= 1 && content.every((b) => b.kind === "para"),
          line: flatLine(blocks ?? []),
        };
      })
    );
    // Tableau de données (Excel, Sheets, Claude) : sans tableau imbriqué ni
    // image, une ligne de texte par cellule, au moins 2×2 une fois les lignes et
    // colonnes vides retirées. Sinon c'est de la mise en page (mails,
    // signatures) : on garde seulement le contenu des cellules.
    const role = el.getAttribute("role");
    const keepRows = cells.filter((row) => row.some((c) => c.line.length));
    const width = Math.max(0, ...keepRows.map((row) => row.length));
    const keepCols = Array.from({ length: width }, (_, i) => i).filter((i) =>
      keepRows.some((row) => row[i]?.line.length)
    );
    const data =
      role !== "presentation" &&
      role !== "none" &&
      !el.querySelector("table, img") &&
      cells.every((row) => row.every((c) => c.simple)) &&
      keepRows.length >= 2 &&
      keepCols.length >= 2;
    if (!data) {
      for (const row of grid) for (const blocks of row) for (const b of blocks ?? []) sink.push(b);
      return;
    }
    // La ligne d'en-tête est déjà grasse : pas de « ** » en plus.
    const rowsOut = keepRows.map((row, r) =>
      keepCols.map((i) => (row[i]?.line ?? []).map((run) => (r ? run : { ...run, bold: false })))
    );
    sink.push({ kind: "table", rows: rowsOut });
  }
}

function wordList(node: Node): { id: string; level: number } | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const m = WORD_LIST.exec(el.getAttribute("style") ?? "");
  // Outlook écrit parfois de vrais <li> avec ce style : ils restent des <li>.
  // Un titre numéroté reste un titre.
  if (!m || el.closest("li") || /^h[1-6]$/.test(el.localName)) return null;
  return { id: m[1].toLowerCase(), level: Number(m[2]) };
}

function wordMarker(el: Element): string {
  const span = Array.from(el.querySelectorAll("[style]")).find((s) =>
    /mso-list\s*:\s*ignore/i.test(s.getAttribute("style") ?? "")
  );
  return (span?.textContent ?? "").replace(/[\s\u00a0]+/g, " ").trim();
}

function isBlankNode(node: Node): boolean {
  if (node.nodeType === Node.COMMENT_NODE) return true;
  return node.nodeType === Node.TEXT_NODE && !/[^ \t\n\r\f]/.test(node.nodeValue ?? "");
}

/** Liste dont tous les éléments sont en ligne (étiquettes « python web ») : pas une liste. */
function inlineItems(list: Element): boolean {
  const items = Array.from(list.children).filter((c) => c.localName === "li");
  return items.length > 0 && items.every((li) => /^inline/.test(styleOf(li, "display") ?? ""));
}

function isCode(el: Element, ctx: Ctx, block: boolean): boolean {
  const tag = el.localName;
  if (PRE_TAGS.has(tag)) return true;
  // <code> affiché en bloc, ou sur plusieurs lignes gardées.
  if (tag === "code")
    return block || (ctx.space !== "normal" && (el.textContent ?? "").includes("\n"));
  // Texte à chasse fixe aux blancs gardés : du code (VS Code, diff GitHub).
  return block && ctx.space === "pre" && ctx.mono;
}

// --- Écriture du Markdown -------------------------------------------------

const isSpace = (c: string) => !c || /\s/u.test(c);
const isPunct = (c: string) => /[\p{P}\p{S}]/u.test(c);
const isWord = (c: string) => !isSpace(c) && !isPunct(c);

function codeSpan(text: string): string {
  const code = text.replace(/\s+/g, " ");
  const longest = Math.max(0, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${ticks}${pad}${code}${pad}${ticks}`;
}

function linkDest(href: string): string {
  const dest = href.replace(/\s/g, "%20");
  return /[()<>]/.test(dest) ? `<${dest.replace(/[<>]/g, encodeURIComponent)}>` : dest;
}

/** Lien affiché sous sa propre adresse : le GFM le rend cliquable tel quel. */
function bareLink(runs: Run[], href: string): boolean {
  const text = runs.map((r) => r.text).join("").trim().replace(/\/$/, "");
  const url = href.replace(/\/$/, "");
  return !!text && (text === url || text === url.replace(/^mailto:/i, "") || url.endsWith(`//${text}`));
}

// Deux marqueurs qui se touchent (« ***vraiment*****, oui** ») ne forment
// qu'une suite d'astérisques, jugée sur les caractères de part et d'autre :
// pour savoir si un marqueur ouvre ou ferme, on regarde à travers eux.

/** Premier caractère d'un morceau, marqueurs ignorés. */
function firstChar(run: Run): string {
  if (/^\s/.test(run.text)) return " ";
  return run.code ? "`" : (run.text[0] ?? "");
}

/** Dernier caractère déjà écrit, marqueurs ignorés. */
function lastChar(out: string): string {
  return out.replace(/[*~]+$/, "").slice(-1);
}

// Une ligne faite seulement de « - » ou « = » soulignerait la précédente en
// titre (« -- » d'une signature) ; « *** », « ``` », « # » ouvriraient un
// filet, un bloc de code ou un titre. On échappe son premier caractère.
const LINE_TRAP = /^ {0,3}(?:(?:-+|=+|([*_])(?:[ \t]*\1){2,})[ \t]*$|`{3}|~{3}|#{1,6}(?:[ \t]|$))/;

class Writer {
  /** Gras, code, lien… : le Markdown dit plus que le texte brut. */
  formatted = false;

  render(blocks: Block[], inItem = false): string {
    let out = "";
    let prev: Block | null = null;
    let blank = false;
    for (const b of blocks) {
      if (b.kind === "blank") {
        blank = true;
        continue;
      }
      const text = this.block(b, inItem);
      if (!text) continue;
      if (prev) {
        // Hors liste, deux paragraphes se suivent ligne à ligne (le rendu les
        // affiche pareil) ; le reste est séparé par une ligne vide, sans
        // laquelle le Markdown collerait un paragraphe au dernier élément d'une
        // liste. Dans un élément, une sous-liste suit son texte, sauf une liste
        // numérotée qui ne commence pas à 1 (elle ne peut pas couper un
        // paragraphe).
        const tight = inItem
          ? prev.kind === "para" && b.kind === "list" && (!b.ordered || b.start === 1)
          : prev.kind === "para" && b.kind === "para";
        out += tight && !blank ? "\n" : "\n\n";
      }
      out += text;
      prev = b;
      blank = false;
    }
    return out;
  }

  private block(b: Block, inItem: boolean): string {
    switch (b.kind) {
      case "para":
        return this.para(b.lines, inItem);
      case "heading": {
        // Un « # » final serait pris pour la fermeture du titre.
        const text = this.line(b.line).replace(/ (#+)$/, " \\$1");
        return text && `${"#".repeat(Math.min(b.level, 3))} ${text}`;
      }
      case "list":
        return this.list(b);
      case "quote":
        return this.render(b.blocks)
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n");
      case "code": {
        const longest = Math.max(2, ...Array.from(b.text.matchAll(/`+/g), (m) => m[0].length));
        const fence = "`".repeat(longest + 1);
        return `${fence}${b.lang}\n${b.text}\n${fence}`;
      }
      case "table": {
        const width = Math.max(...b.rows.map((r) => r.length));
        const row = (cells: Line[]) =>
          `| ${Array.from({ length: width }, (_, i) =>
            this.line(cells[i] ?? []).replace(/\|/g, "\\|")
          ).join(" | ")} |`;
        return [row(b.rows[0]), `|${" --- |".repeat(width)}`, ...b.rows.slice(1).map(row)].join(
          "\n"
        );
      }
      case "rule":
        return "---";
      case "blank":
        return "";
    }
  }

  private para(lines: Line[], inItem: boolean): string {
    const texts = lines.map((line) => {
      const text = this.line(line);
      return LINE_TRAP.test(text) ? `\\${text.trimStart()}` : text;
    });
    if (!inItem) return texts.join("\n");
    // Dans un élément de liste, le rendu ne garde pas un simple saut de
    // ligne : on écrit un saut forcé (deux espaces en fin de ligne).
    return texts.map((text, i) => (text && texts[i + 1] ? `${text}  ` : text)).join("\n");
  }

  private list(list: ListBlock): string {
    return list.items
      .map((item, i) => {
        const marker = list.ordered ? `${list.start + i}. ` : "- ";
        const pad = " ".repeat(marker.length);
        const body = this.render(item, true);
        if (!body) return "";
        return marker + body.split("\n").map((line, j) => (j && line ? pad + line : line)).join("\n");
      })
      .filter(Boolean)
      .join("\n");
  }

  /** Une ligne : les liens regroupent leurs morceaux, la mise en forme suit. */
  line(runs: Line): string {
    let out = "";
    for (let i = 0; i < runs.length; ) {
      const href = runs[i].href;
      let j = i + 1;
      while (j < runs.length && runs[j].href === href) j++;
      const group = runs.slice(i, j);
      const link = href && !bareLink(group, href);
      let k = j;
      while (k < runs.length && runs[k].href === runs[j]?.href) k++;
      const next = runs[j];
      const after = !next
        ? ""
        : next.href && !bareLink(runs.slice(j, k), next.href)
          ? "["
          : firstChar(next);
      if (link) {
        this.formatted = true;
        out += `[${this.runs(group, "[", "]", true)}](${linkDest(href)})`;
      } else {
        out += this.runs(group, lastChar(out), after, false);
      }
      i = j;
    }
    return out;
  }

  private runs(group: Run[], before: string, after: string, inLink: boolean): string {
    let out = "";
    group.forEach((run, k) => {
      const prev = out ? lastChar(out) : before;
      const next = k + 1 < group.length ? firstChar(group[k + 1]) : after;
      out += this.run(run, prev, next, inLink);
    });
    return out;
  }

  /**
   * Un morceau, avec ses marqueurs. Chaque morceau porte les siens : CommonMark
   * sait recoller « **gras***italique* ». Les blancs de bord restent dehors, et
   * la ponctuation de bord aussi quand une lettre touche le marqueur, sinon
   * « **Étape 1 :**Installer » ne serait pas du gras.
   */
  private run(run: Run, prev: string, next: string, inLink: boolean): string {
    if (run.code) {
      this.formatted = true;
      return codeSpan(run.text);
    }
    const text = inLink ? run.text.replace(/[[\]]/g, "\\$&") : run.text;
    const open = (run.strike ? "~~" : "") + (run.bold ? "**" : "") + (run.italic ? "*" : "");
    if (!open) return text;
    let [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
    if (!lead && isWord(prev)) {
      lead = /^[\p{P}\p{S}\s]*/u.exec(core)![0];
      core = core.slice(lead.length);
    }
    if (!tail && isWord(next)) {
      tail = /[\p{P}\p{S}\s]*$/u.exec(core)![0];
      core = core.slice(0, core.length - tail.length);
    }
    if (!core) return text;
    this.formatted = true;
    const close = open.split("").reverse().join("");
    return `${lead}${open}${core}${close}${tail}`;
  }
}

function isSpecial(b: Block): boolean {
  return b.kind !== "para" && b.kind !== "blank";
}

interface Converted {
  md: string;
  /** Le Markdown commence ou finit par un bloc qui veut sa propre ligne. */
  blockStart: boolean;
  blockEnd: boolean;
}

function convert(html: string): Converted | null {
  if (html.length > MAX_HTML) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks = new Converter().blocks(doc.body, ROOT);
  const content = blocks.filter((b) => b.kind !== "blank");
  if (!content.length) return null;
  // Rien que du code : VS Code, un <pre> nu, une ligne de commande… arrivent
  // tels quels. Seul un vrai bloc de code de plusieurs lignes est entouré de ```.
  const only = content.length === 1 ? content[0] : null;
  if (only?.kind === "code" && !(only.explicit && only.text.includes("\n"))) return null;
  const writer = new Writer();
  const md = writer.render(blocks);
  if (!md.includes("\n")) return null;
  if (!content.some(isSpecial) && !writer.formatted) return null;
  return { md, blockStart: isSpecial(content[0]), blockEnd: isSpecial(content.at(-1)!) };
}

/**
 * Markdown équivalent au HTML copié, ou null quand le collage natif fait
 * aussi bien (aucune mise en forme, résultat sur une seule ligne, code seul).
 */
export function htmlToMarkdown(html: string): string | null {
  return convert(html)?.md ?? null;
}

/** Le texte brut est déjà du Markdown (bouton « Copier » d'une IA, éditeur). */
function looksLikeMarkdown(plain: string): boolean {
  return (
    /(?:^|\n) {0,3}(?:```|~~~|#{1,6} \S|\|? *:?-{3,}:? *\|)/.test(plain) ||
    /\*\*\S[^\n]*?\*\*|(?:^|[^`])`[^`\n]+`|\]\(https?:\/\//.test(plain)
  );
}

/** Le curseur est dans un bloc ``` ouvert plus haut et pas encore refermé. */
function insideFence(before: string): boolean {
  let fence: { char: string; size: number } | null = null;
  for (const raw of before.split("\n")) {
    // Citations (« > ») et retraits de liste ne changent rien à la clôture.
    const line = raw.replace(/^(?:[ \t]*>)*[ \t]*/, "");
    const m = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const char = m[1][0];
    if (!fence) {
      // « ```npm ci``` » sur une ligne est du code en ligne, pas un bloc.
      if (!(char === "`" && m[2].includes("`"))) fence = { char, size: m[1].length };
    } else if (char === fence.char && m[1].length >= fence.size && !m[2].trim()) {
      fence = null;
    }
  }
  return fence !== null;
}

// Ctrl+Maj+V colle le texte brut. Chromium ne fournit alors que lui, mais
// Firefox passe aussi le HTML : on retient l'appui pour laisser faire.
let plainPasteAt = -Infinity;
if (typeof document !== "undefined") {
  document.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v")
        plainPasteAt = e.timeStamp;
    },
    true
  );
}

/** Lignes vides à ajouter pour qu'un bloc collé en milieu de texte reste un bloc. */
function padded({ md, blockStart, blockEnd }: Converted, before: string, after: string): string {
  let out = md;
  if (blockStart && /\S/.test(before)) {
    const newlines = /\n*[ \t]*$/.exec(before)![0].split("\n").length - 1;
    out = "\n".repeat(Math.max(0, 2 - newlines)) + out;
  }
  if (blockEnd && /\S/.test(after)) {
    const newlines = /^[ \t]*\n*/.exec(after)![0].split("\n").length - 1;
    out += "\n".repeat(Math.max(0, 2 - newlines));
  }
  return out;
}

// Au-delà, execCommand (dont le coût croît comme lignes collées × lignes du
// champ : 2,6 s pour 1 500 lignes) gèlerait l'onglet. On insère alors
// directement, sans annulation native ; en deçà, au pire ~60 ms (WebKit).
const UNDOABLE_LINES = 20_000;

function insertText(ta: HTMLTextAreaElement, text: string) {
  ta.focus();
  const lines = (s: string) => s.split("\n").length;
  // execCommand est déprécié mais reste le seul moyen d'insérer du texte en
  // gardant l'historique natif : Ctrl+Z annule le collage d'un coup. Il émet
  // aussi l'événement input, donc le onChange de React.
  if (
    lines(text) * (lines(ta.value) + lines(text)) <= UNDOABLE_LINES &&
    document.execCommand("insertText", false, text)
  )
    return;
  ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * onPaste des champs de message : colle la traduction Markdown du HTML copié
 * quand elle apporte quelque chose, sinon laisse faire le navigateur.
 */
export function pasteAsMarkdown(e: ClipboardEvent<HTMLTextAreaElement>): boolean {
  if (e.timeStamp - plainPasteAt < 1000) return false;
  const ta = e.currentTarget;
  const before = ta.value.slice(0, ta.selectionStart);
  if (insideFence(before)) return false;
  const html = e.clipboardData?.getData("text/html");
  if (!html || looksLikeMarkdown(e.clipboardData.getData("text/plain"))) return false;
  const result = convert(html);
  if (!result) return false;
  e.preventDefault();
  insertText(ta, padded(result, before, ta.value.slice(ta.selectionEnd)));
  return true;
}
