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
  // Dans une boîte en ligne (inline-flex, inline-block) : rien n'y va à la ligne.
  inline: boolean;
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
  // <pre><code>, coloration syntaxique : un vrai bloc de code. Sinon (<pre>
  // nu, texte à chasse fixe de VS Code), seul, il est laissé au collage natif.
  explicit: boolean;
  // Fait de lignes d'une ligne chacune réunies (SyntaxHighlighter).
  joined?: boolean;
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
  inline: false,
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
// <img>, <input> et les formules sont traités à part ; un <button> garde son
// texte (question d'une FAQ, mention), sauf un bouton d'outil (« Copier »).
const SKIP = new Set([
  "head", "title", "meta", "link", "style", "script", "template", "noscript",
  "select", "option", "textarea", "svg", "canvas", "video", "audio",
  "iframe", "object", "embed", "source", "map", "area",
]);

// Libellé entier d'un bouton d'outil (bloc de code, message) : pas du contenu.
const TOOL_BUTTON = new RegExp(
  `^(?:${[
    "copy", "copy code", "copy to clipboard", "copied", "copier", "copier le code",
    "copier dans le presse-papiers", "copié", "code copié", "run", "exécuter", "wrap", "edit",
    "modifier", "download", "télécharger", "raw",
  ].join("|")})[!.]?$`,
  "i"
);

// Numéros de ligne affichés à côté d'un bloc de code (Pygments, Prism…).
const LINE_NUMBERS = /(?:^|\s)(?:linenos|line-numbers-rows|hljs-ln-numbers)(?:\s|$)/;

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
  if (tag === "button" && TOOL_BUTTON.test((el.textContent ?? "").trim())) return true;
  const cls = el.getAttribute("class");
  // La gouttière et la barre d'outils de SyntaxHighlighter (Confluence, WordPress).
  if (
    cls &&
    (LINE_NUMBERS.test(cls) ||
      (/(?:^|\s)(?:gutter|toolbar)(?:\s|$)/.test(cls) && el.closest(".syntaxhighlighter")))
  )
    return true;
  const style = el.getAttribute("style");
  return (
    !!style &&
    (styleOf(el, "display") === "none" || /mso-list\s*:\s*ignore|mso-hide\s*:\s*all/i.test(style))
  );
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

// « display: -webkit-box » est la troncature CSS (line-clamp) d'un paragraphe
// ordinaire : pas une boîte flex.
function isFlex(el: Element): boolean {
  return /^(flex|grid)$/.test(styleOf(el, "display") ?? "");
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
  if (role === "presentation" || role === "none") return "";
  const alt = (el.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim();
  // Description qu'Office génère seul (« Une image contenant texte… ») : du bruit.
  return /générée automatiquement|automatically generated/i.test(alt) ? "" : alt;
}

/**
 * Source TeX d'une formule (KaTeX, MathML annoté), en « $…$ » comme dans le
 * Markdown d'une IA. Le rendu visuel de KaTeX, lui, est illisible en texte.
 */
function mathTex(el: Element): string | null {
  const tex = (
    el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ??
    el.getAttribute("alttext") ??
    ""
  ).trim();
  if (!tex) return null;
  return el.closest(".katex-display") || el.getAttribute("display") === "block"
    ? `$$${tex}$$`
    : `$${tex}$`;
}

/**
 * Formule MathML en texte linéaire (« E=mc^2 », « a/b ») : Chromium ne copie
 * pas l'<annotation> qui porte le TeX de KaTeX.
 */
function mathText(el: Element): string {
  const kids = Array.from(el.children);
  const part = (i: number) => (kids[i] ? mathText(kids[i]) : "");
  const group = (s: string) => (Array.from(s).length > 1 ? `(${s})` : s);
  switch (el.localName) {
    case "annotation":
    case "annotation-xml":
      return "";
    case "mfrac":
      return `${group(part(0))}/${group(part(1))}`;
    case "msup":
      return `${part(0)}^${group(part(1))}`;
    case "msub":
      return `${part(0)}_${group(part(1))}`;
    case "msubsup":
      return `${part(0)}_${group(part(1))}^${group(part(2))}`;
    case "msqrt":
      return `√${group(kids.map(mathText).join(""))}`;
    case "mroot":
      return `${part(1)}√${group(part(0))}`;
  }
  return kids.length ? kids.map(mathText).join("") : (el.textContent ?? "").trim();
}

/** Cellule faite seulement d'images (logo, icônes d'une signature) : de la mise en page. */
function imageCell(cell: Element): boolean {
  const imgs = Array.from(cell.querySelectorAll("img"));
  return (
    imgs.length > 0 &&
    !(cell.textContent ?? "").trim() &&
    imgs.some((img) => !/^\p{Extended_Pictographic}/u.test(img.getAttribute("alt") ?? ""))
  );
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
    const plain = { ...run, code: false };
    if (m[1]) pieces.push({ ...plain, text: " " });
    if (m[2]) pieces.push({ ...run, text: m[2].replace(/\s+/g, " ") });
    if (m[3]) pieces.push({ ...plain, text: " " });
  }
  const out: Run[] = [];
  for (const run of pieces) {
    // Chromium écrit en espace insécable (<span>&nbsp;</span>) les espaces
    // en bord de balise : ce sont des espaces ordinaires.
    let text = run.text.replace(/[ \t\f\r\u00a0]+/g, " ");
    const prev = out.at(-1);
    if (text.startsWith(" ") && (!prev || prev.text.endsWith(" "))) text = text.slice(1);
    if (!text) continue;
    if (prev && sameStyle(prev, run)) prev.text += text;
    else out.push({ ...run, text });
  }
  while (out.length && out[0].text.startsWith(" ")) {
    out[0].text = out[0].text.slice(1);
    if (!out[0].text) out.shift();
  }
  while (out.length && out.at(-1)!.text.endsWith(" ")) {
    out.at(-1)!.text = out.at(-1)!.text.slice(0, -1);
    if (!out.at(-1)!.text) out.pop();
  }
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
 * (une par <div> chez VS Code ou dans un diff, un <code> par ligne chez
 * SyntaxHighlighter) forment un seul bloc, et l'étiquette de langage posée
 * juste au-dessus d'un bloc de code disparaît.
 */
function tidy(blocks: Block[]): Block[] {
  const out: Block[] = [];
  const oneLine = (c: CodeBlock) => !c.text.includes("\n");
  for (const b of blocks) {
    const prev = out.at(-1);
    if (
      b.kind === "code" &&
      prev?.kind === "code" &&
      prev.lang === b.lang &&
      prev.explicit === b.explicit &&
      (!b.explicit || (oneLine(b) && (prev.joined || oneLine(prev))))
    ) {
      out[out.length - 1] = { ...prev, text: `${prev.text}\n${b.text}`, joined: true };
      continue;
    }
    out.push(b);
  }
  return out.filter((b, i) => {
    if (b.kind === "code") return !!b.text.trim();
    if (b.kind === "list") return b.items.length > 0;
    if (b.kind === "quote") return b.blocks.some((x) => x.kind !== "blank");
    if (b.kind === "heading") return b.line.length > 0;
    // Une étiquette en gras (« **Python** ») est du texte écrit : elle reste.
    const next = out[i + 1];
    return !(
      b.kind === "para" &&
      next?.kind === "code" &&
      next.lang &&
      b.lines.length === 1 &&
      b.lines[0].every((r) => !r.bold && !r.italic && !r.strike && !r.code && !r.href) &&
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
    if (tag === "math" || el.classList.contains("katex")) {
      // En code : ni « _ » ni « \ » d'une formule ne sont lus comme du Markdown.
      // Le rendu visuel de KaTeX (katex-html) est laissé de côté.
      const math = tag === "math" ? el : el.querySelector("math");
      const formula = mathTex(el) ?? (math ? mathText(math) : "");
      if (formula) {
        sink.text(formula, { ...ctx, code: true });
        return;
      }
      if (tag === "math") return;
    }
    const inner = this.inherit(el, ctx);
    const block = !ctx.inline && isBlockLevel(el, flexItem);
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
    if (tag === "details" && !el.hasAttribute("open")) {
      // Fermé, seul son titre est à l'écran (Chromium en copie parfois le contenu).
      const summary = Array.from(el.children).find((c) => c.localName === "summary");
      if (summary) this.node(summary, inner, sink, false);
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
    // Une boîte inline-flex (icône + libellé, pastille de source d'une IA)
    // reste sur la ligne, une espace entre ses éléments.
    const display = styleOf(el, "display") ?? "";
    if (/^inline-(flex|grid)$/.test(display)) {
      Array.from(el.childNodes).forEach((child, i) => {
        if (i) sink.text(" ", inner);
        this.node(child, { ...inner, inline: true }, sink, false);
      });
      return;
    }
    this.children(el, display === "inline-block" ? { ...inner, inline: true } : inner, sink, false);
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
    const codes = el.localName === "code" ? [el] : Array.from(el.querySelectorAll("code"));
    const code = codes[0] ?? null;
    // Le seul <code> d'un bloc porte le code : l'étiquette « python » et le
    // bouton « Copier » posés autour dans le même <pre> n'en font pas partie.
    const source = codes.length === 1 ? code! : el;
    const text = preText(source).replace(/\u00a0/g, " ").replace(/^\n+|\s+$/g, "");
    // Classes du bloc et de ses parents : language-x, highlight-source-x
    // (GitHub), highlight-x (Sphinx), hljs…
    let classes = code?.getAttribute("class") ?? "";
    for (let up: Element | null = el, i = 0; up && i < 3; up = up.parentElement, i++)
      classes += ` ${up.getAttribute("class") ?? ""}`;
    const lang =
      /(?:^|\s)(?:(?:language|lang|highlight-source|highlight)-|brush:\s*)([\w+#.-]+)/.exec(
        classes
      )?.[1] ?? "";
    const highlighted = /(?:^|\s)(?:highlight|sourceCode|hljs|prettyprint|codehilite)(?:\s|$)/.test(
      classes
    );
    return {
      kind: "code",
      text,
      lang: /^(?:default|none|nohighlight|plain|text)$/i.test(lang) ? "" : lang,
      explicit: !!code || !!lang || highlighted,
    };
  }

  private table(el: Element, ctx: Ctx, sink: Sink) {
    const caption = Array.from(el.children).find((c) => c.localName === "caption");
    if (caption && !skipped(caption))
      for (const b of this.blocks(caption, this.inherit(caption, ctx))) sink.push(b);
    // Grille des cellules, cellules fusionnées (rowspan/colspan) dépliées.
    const rows = Array.from((el as HTMLTableElement).rows).filter((r) => !skipped(r));
    const grid: (Block[] | null)[][] = rows.map(() => []);
    let images = false;
    rows.forEach((row, r) => {
      let c = 0;
      for (const cell of Array.from(row.cells)) {
        if (skipped(cell)) continue;
        images ||= imageCell(cell);
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
          // Des paragraphes seulement, réunis sur la ligne du tableau.
          simple: content.every((b) => b.kind === "para"),
          oneLine:
            content.length === 1 && content[0].kind === "para" && content[0].lines.length === 1,
          line: flatLine(blocks ?? []),
        };
      })
    );
    // Tableau de données (Excel, Sheets, Claude) : sans tableau imbriqué ni
    // cellule faite d'images hors en-têtes <th> (logo d'une signature ; un
    // drapeau devant un nom ou un badge sous un en-tête, oui), des paragraphes
    // dans les cellules, au moins 2×2 une fois les lignes et colonnes vides
    // retirées. Sinon c'est de la mise en page (mails, signatures) : on garde
    // seulement le contenu des cellules.
    const role = el.getAttribute("role");
    const keepRows = cells.filter((row) => row.some((c) => c.line.length));
    const width = Math.max(0, ...keepRows.map((row) => row.length));
    const keepCols = Array.from({ length: width }, (_, i) => i).filter((i) =>
      keepRows.some((row) => row[i]?.line.length)
    );
    const data =
      role !== "presentation" &&
      role !== "none" &&
      (!images || !!el.querySelector("th")) &&
      !el.querySelector("table") &&
      cells.every((row) => row.every((c) => c.simple)) &&
      keepRows.length >= 2 &&
      keepCols.length >= 2;
    if (!data) {
      // Une seule ligne copiée (Excel, Sheets) reste une ligne, ses cellules
      // séparées par une tabulation comme dans le texte brut.
      const row = keepRows.length === 1 ? keepRows[0].filter((c) => c.line.length) : [];
      if (row.length > 1 && row.every((c) => c.oneLine)) {
        const tab = { ...BREAK, text: "\t" };
        const line = row.flatMap((c, i) => (i ? [tab, ...c.line] : c.line));
        sink.push({ kind: "para", lines: [line] });
        return;
      }
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
  // <code> affiché en bloc par son propre style (pas comme élément d'une boîte
  // flex : « Commit <code>a1b2c3d</code> »), ou sur plusieurs lignes gardées.
  if (tag === "code")
    return (
      isBlockLevel(el, false) || (ctx.space !== "normal" && (el.textContent ?? "").includes("\n"))
    );
  // Texte à chasse fixe aux blancs gardés : du code (VS Code, diff GitHub).
  return block && ctx.space === "pre" && ctx.mono;
}

// --- Écriture du Markdown -------------------------------------------------

const isSpace = (c: string) => !c || /\s/u.test(c);
const isPunct = (c: string) => /[\p{P}\p{S}]/u.test(c);
const isWord = (c: string) => !isSpace(c) && !isPunct(c);

// Caractères de bord comme le rendu (micromark) les classe : par unité UTF-16,
// si bien qu'un emoji hors du plan de base y compte comme une lettre.
const firstOf = (s: string) => s.charAt(0);
const lastOf = (s: string) => s.charAt(s.length - 1);

let segmenter: Intl.Segmenter | null | undefined;
/** Caractères tels qu'affichés : un emoji composé (👩‍💻) n'est jamais coupé. */
function graphemes(text: string): string[] {
  segmenter ??= typeof Intl.Segmenter === "function" ? new Intl.Segmenter() : null;
  return segmenter ? Array.from(segmenter.segment(text), (g) => g.segment) : Array.from(text);
}

const STRIKE = 1;
const BOLD = 2;
const ITALIC = 4;
// Ordre d'ouverture à durée égale, du plus extérieur au plus intérieur.
const MARKS: [number, string][] = [
  [STRIKE, "~~"],
  [BOLD, "**"],
  [ITALIC, "*"],
];
const markOf = (bit: number) => MARKS.find(([b]) => b === bit)![1];

/** Un caractère mis en forme, un morceau sans style, ou un bout de code entier. */
interface Atom {
  text: string;
  /** Caractères de bord vus par CommonMark (« ` » pour du code). */
  first: string;
  last: string;
  mask: number;
  code: string | null;
}

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

/**
 * Lien affiché sous sa propre adresse : le GFM le rend cliquable tel quel.
 * Pas « exemple.fr » sans https:// (ce ne serait plus un lien), ni « www.… »
 * (il deviendrait http://).
 */
function bareLink(runs: Run[], href: string): boolean {
  const text = runs.map((r) => r.text).join("").trim().replace(/\/$/, "");
  const url = href.replace(/\/$/, "");
  return !!text && (text === url || (/^mailto:/i.test(url) && text === url.slice(7)));
}

// Une ligne faite seulement de « - » ou « = » soulignerait la précédente en
// titre (« -- » d'une signature) ; « *** », « - - - », « ``` », « # »
// ouvriraient un filet, un bloc de code ou un titre. On échappe son premier
// caractère. (« ````x ``` y```` », du code en ligne, n'ouvre pas de bloc.)
const LINE_TRAP =
  /^ {0,3}(?:(?:-+|=+|([*_-])(?:[ \t]*\1){2,})[ \t]*$|`{3,}[^`]*$|~{3}|#{1,6}(?:[ \t]|$))/;

class Writer {
  /** Gras, code, lien… : le Markdown dit plus que le texte brut. */
  formatted = false;

  render(blocks: Block[], inItem = false): string {
    let out = "";
    let prev: Block | null = null;
    let prevAlt = false;
    let blank = false;
    for (const b of blocks) {
      if (b.kind === "blank") {
        blank = true;
        continue;
      }
      // Deux listes du même type à la suite n'en feraient qu'une : la seconde
      // change de marqueur (« * », « 1) »).
      const alt: boolean =
        b.kind === "list" && prev?.kind === "list" && prev.ordered === b.ordered && !prevAlt;
      const text = b.kind === "list" ? this.list(b, alt) : this.block(b, inItem);
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
      prevAlt = alt;
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
        return this.list(b, false);
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

  private list(list: ListBlock, alt: boolean): string {
    return list.items
      .map((item, i) => {
        const marker = list.ordered ? `${list.start + i}${alt ? ")" : "."} ` : alt ? "* " : "- ";
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
    // Un lien affiché sous sa propre adresse s'écrit comme du texte.
    const hrefs = runs.map((r) => r.href);
    for (let i = 0; i < runs.length; ) {
      const href = runs[i].href;
      let j = i + 1;
      while (j < runs.length && runs[j].href === href) j++;
      if (href && bareLink(runs.slice(i, j), href)) hrefs.fill(null, i, j);
      i = j;
    }
    let out = "";
    for (let i = 0; i < runs.length; ) {
      const href = hrefs[i];
      let j = i + 1;
      while (j < runs.length && hrefs[j] === href) j++;
      const group = runs.slice(i, j);
      if (!href) {
        out += this.runs(group, lastOf(out), j < runs.length ? "[" : "", false);
      } else {
        // Les blancs de bord sortent des crochets.
        const inner = this.runs(group, "[", "]", true);
        const [, lead, text, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
        out += lead;
        if (text) {
          this.formatted = true;
          // « ![…](…) » serait une image.
          if (/(?:^|[^\\])!$/.test(out)) out = `${out.slice(0, -1)}\\!`;
          out += `[${text}](${linkDest(href)})`;
        }
        out += tail;
      }
      i = j;
    }
    return out;
  }

  /**
   * Une suite de morceaux hors lien, ou le texte d'un lien. Les styles
   * s'ouvrent et se ferment comme une pile, le plus durable à l'extérieur :
   * « *a **b** c* », et non « *a* ***b*** *c* » que CommonMark apparie mal.
   */
  private runs(group: Run[], before: string, after: string, inLink: boolean): string {
    const esc = (s: string) => (inLink ? s.replace(/[[\]]/g, "\\$&") : s);
    const atoms: Atom[] = [];
    for (const run of group) {
      const mask = (run.strike ? STRIKE : 0) | (run.bold ? BOLD : 0) | (run.italic ? ITALIC : 0);
      if (run.code) {
        atoms.push({ text: "", first: "`", last: "`", mask, code: run.text });
      } else {
        // Sans style, un morceau reste entier : seuls ses bords comptent.
        for (const g of mask ? graphemes(run.text) : [run.text])
          atoms.push({ text: esc(g), first: firstOf(g), last: lastOf(g), mask, code: null });
      }
    }
    const n = atoms.length;
    const blank = (a: Atom) => a.code === null && !/\S/.test(a.text);
    // Un blanc entre deux morceaux prend leur mise en forme commune.
    atoms.forEach((a, k) => {
      if (!blank(a)) return;
      let p = k - 1;
      while (p >= 0 && blank(atoms[p])) p--;
      let q = k + 1;
      while (q < n && blank(atoms[q])) q++;
      a.mask = (p >= 0 ? atoms[p].mask : 0) & (q < n ? atoms[q].mask : 0);
    });
    // Un marqueur ne touche pas un blanc, ni une ponctuation qu'une lettre
    // touche de l'autre côté (« **Étape 1 :**Installer » ne serait pas du
    // gras) : la zone de chaque style rétrécit jusqu'à pouvoir s'ouvrir et se
    // fermer.
    const prevChar = (k: number) => (k > 0 ? atoms[k - 1].last : before);
    const nextChar = (k: number) => (k < n ? atoms[k].first : after);
    const opens = (k: number) =>
      !isSpace(atoms[k].first) && !(isPunct(atoms[k].first) && isWord(prevChar(k)));
    const closes = (k: number) =>
      !isSpace(atoms[k - 1].last) && !(isPunct(atoms[k - 1].last) && isWord(nextChar(k)));
    for (const [bit] of MARKS) {
      for (let i = 0; i < n; ) {
        if (!(atoms[i].mask & bit)) {
          i++;
          continue;
        }
        let j = i;
        while (j < n && atoms[j].mask & bit) j++;
        let a = i;
        let b = j;
        while (a < b && !opens(a)) a++;
        while (b > a && !closes(b)) b--;
        for (let k = i; k < j; k++) if (k < a || k >= b) atoms[k].mask &= ~bit;
        i = j;
      }
    }
    // Le barré et le gras (ou l'italique) qui changent ensemble contre une
    // lettre ne s'écrivent pas (« ~~**x**~~y » reste littéral) : le barré, qui
    // a un sens, est gardé.
    const EMPHASIS = BOLD | ITALIC;
    for (let k = 0; k <= n; k++) {
      const prevMask = k > 0 ? atoms[k - 1].mask : 0;
      const nextMask = k < n ? atoms[k].mask : 0;
      const closing = prevMask & ~nextMask;
      const opening = nextMask & ~prevMask;
      if (!opening && closing & STRIKE && closing & EMPHASIS && isWord(nextChar(k))) {
        const bits = closing & EMPHASIS;
        for (let e = k - 1; e >= 0 && atoms[e].mask & bits; e--) atoms[e].mask &= ~bits;
      }
      if (!closing && opening & STRIKE && opening & EMPHASIS && isWord(prevChar(k))) {
        const bits = opening & EMPHASIS;
        for (let e = k; e < n && atoms[e].mask & bits; e++) atoms[e].mask &= ~bits;
      }
    }
    // Deux bouts de code de même style qui se touchent n'en font qu'un.
    const seq: Atom[] = [];
    for (const a of atoms) {
      const p = seq.at(-1);
      if (p?.code != null && a.code !== null && p.mask === a.mask) p.code += a.code;
      else seq.push(a);
    }
    const until = (k: number, bit: number) => {
      let e = k;
      while (e < seq.length && seq[e].mask & bit) e++;
      return e;
    };
    let out = "";
    let textEnd = false;
    // Marqueur ou bout de code : un « \ » du texte qui le touche l'échapperait,
    // un « * » ou un « ` » s'y ajouterait.
    const put = (m: string) => {
      if (!m) return;
      this.formatted = true;
      if (textEnd) {
        if ((/\\+$/.exec(out)?.[0].length ?? 0) % 2) out += "\\";
        else if (out.endsWith(m[0])) out = `${out.slice(0, -1)}\\${m[0]}`;
      }
      out += m;
      textEnd = false;
    };
    const stack: number[] = [];
    let dropped = 0;
    for (let k = 0; k <= seq.length; k++) {
      const atom = seq[k];
      dropped &= atom?.mask ?? 0;
      const want = (atom?.mask ?? 0) & ~dropped;
      const cut = stack.findIndex((bit) => !(want & bit));
      const closed = cut < 0 ? [] : stack.splice(cut).reverse();
      const closers = closed.map(markOf).join("");
      let open = MARKS.map(([bit]) => bit)
        .filter((bit) => want & bit && !stack.includes(bit))
        .sort((x, y) => until(k, y) - until(k, x));
      // Rouvrir aussitôt un style qu'on vient de fermer collerait ses
      // astérisques aux autres (« ****b ») : il s'arrête là.
      const reopen = closed.filter((bit) => want & bit);
      const first = open.length ? markOf(open[0])[0] : "";
      if (reopen.length && first && closers.endsWith(first)) {
        for (const bit of reopen) dropped |= bit;
        open = open.filter((bit) => !reopen.includes(bit));
      }
      put(closers);
      put(open.map(markOf).join(""));
      stack.push(...open);
      if (!atom) break;
      if (atom.code !== null) {
        put(codeSpan(atom.code));
        continue;
      }
      // De même pour un « * » ou un « ` » du texte juste après.
      const last = textEnd ? "" : out.slice(-1);
      out += last && atom.text.startsWith(last) ? `\\${atom.text}` : atom.text;
      textEnd = true;
    }
    return out;
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

/**
 * Le texte brut est le Markdown source de ce qui a été copié (bouton
 * « Copier » d'une IA, éditeur Markdown) : il porte des marqueurs absents du
 * texte de la page. Un « # » ou des ``` qui sont aussi dans la page (le
 * commentaire d'un bloc de code) n'en sont pas.
 */
function markdownSource(plain: string, page: () => string): boolean {
  const BLOCK = /^ {0,3}(?:```|~~~|#{1,6} \S|\|? *:?-{3,}:? *\|)/;
  const INLINE = /\*\*\S[^\n]*?\*\*|`[^`\n]+`|\]\(https?:\/\/[^)\s]*\)|\$[^$\n]+\$/g;
  const candidates = [
    ...plain.split("\n").filter((line) => BLOCK.test(line)),
    ...Array.from(plain.matchAll(INLINE), (m) => m[0]),
  ].slice(0, 100);
  if (!candidates.length) return false;
  const text = page().replace(/\s+/g, " ");
  return candidates.some((c) => !text.includes(c.replace(/\s+/g, " ").trim()));
}

function convert(html: string, plain = ""): Converted | null {
  if (html.length > MAX_HTML) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (plain && markdownSource(plain, () => doc.body.textContent ?? "")) return null;
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

/** Le curseur est dans un bloc ``` ouvert plus haut et pas encore refermé. */
function insideFence(before: string): boolean {
  let fence: { char: string; size: number; quoted: boolean } | null = null;
  for (const raw of before.split("\n")) {
    const quoted = /^[ \t]*>/.test(raw);
    // Un bloc ouvert dans une citation se ferme avec elle.
    if (fence?.quoted && !quoted) fence = null;
    // Citations (« > ») et retraits de liste ne changent rien à la clôture.
    const line = raw.replace(/^(?:[ \t]*>)*[ \t]*/, "");
    const m = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const char = m[1][0];
    if (!fence) {
      // « ```npm ci``` » sur une ligne est du code en ligne, pas un bloc.
      if (!(char === "`" && m[2].includes("`"))) fence = { char, size: m[1].length, quoted };
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
  if (!html) return false;
  const result = convert(html, e.clipboardData.getData("text/plain"));
  if (!result) return false;
  e.preventDefault();
  insertText(ta, padded(result, before, ta.value.slice(ta.selectionEnd)));
  return true;
}
