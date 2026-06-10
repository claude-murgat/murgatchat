/* eslint-disable no-console */
"use strict";

/**
 * Génère les icônes PNG pour la PWA et les notifications, sans dépendance
 * externe : on encode des PNG RGBA "à la main" (signature + chunks
 * IHDR/IDAT/IEND, compression zlib).
 *
 * Design : fond aubergine #3F0E40 (couleur de marque Slack-like) + "#" blanc
 * stylisé (en référence à l'iconographie des canaux). Cohérent avec le favicon
 * SVG dans index.html et le theme_color du manifest.
 *
 * Sorties dans web/public/icons/ :
 *   - icon-192.png         (192×192, "any" — écran d'accueil iOS/Android)
 *   - icon-512.png         (512×512, "any" — splash screen Android)
 *   - icon-512-maskable.png(512×512, "maskable" — avec safe-zone ~10% pour Android crop)
 *   - badge-72.png         (72×72, monochrome blanc — petite badge Android dans la status bar)
 *
 * Re-exécuter : `node web/scripts/generate-icons.cjs` (idempotent).
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// --- CRC32 (table standard PNG) ---
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, pixelFn) {
  // pixelFn(x, y) → [r, g, b, a]
  const rowLen = 1 + size * 4;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowLen;
    raw[rowStart] = 0; // filtre "None"
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const off = rowStart + 1 + x * 4;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Couleurs murgatchat (cf tailwind.config.js).
const AUBERGINE = [0x3f, 0x0e, 0x40]; // #3F0E40
const WHITE = [255, 255, 255];

// Dessine un "#" stylisé centré dans une zone carrée (cx, cy, half-size).
// Deux barres verticales + deux barres horizontales, traits arrondis (un peu).
// Retourne true si (x, y) tombe sur le "#".
function isHashPixel(x, y, cx, cy, half) {
  const dx = x - cx;
  const dy = y - cy;
  // Taille du "#" (un peu inscrit dans la zone safe).
  const stroke = half * 0.18; // épaisseur des barres
  const spacing = half * 0.38; // moitié de l'écart entre les deux barres
  const length = half * 0.78;
  // Barres verticales (x ≈ ±spacing).
  const v1 = Math.abs(dx + spacing) <= stroke / 2 && Math.abs(dy) <= length;
  const v2 = Math.abs(dx - spacing) <= stroke / 2 && Math.abs(dy) <= length;
  // Barres horizontales (y ≈ ±spacing) — légèrement inclinées vers le haut
  // à droite pour le look Slack-channel-glyph.
  const slant = -0.18; // pente (positif = barre monte vers la droite)
  const dyTop = dy - (-spacing) - slant * dx;
  const dyBot = dy - spacing - slant * dx;
  const h1 = Math.abs(dyTop) <= stroke / 2 && Math.abs(dx) <= length;
  const h2 = Math.abs(dyBot) <= stroke / 2 && Math.abs(dx) <= length;
  return v1 || v2 || h1 || h2;
}

function pngHashOnAubergine(size, { maskable = false, monochrome = false } = {}) {
  // En "maskable" on garde le contenu dans un cercle de safe-zone à 40% du côté
  // (recommandation Android : safe-zone ratio 80% du diamètre, soit 40% du côté).
  const cx = size / 2;
  const cy = size / 2;
  const half = (size / 2) * (maskable ? 0.62 : 0.88);
  return encodePng(size, (x, y) => {
    const hash = isHashPixel(x, y, cx, cy, half);
    if (monochrome) {
      // Badge Android : transparent partout sauf le glyphe (blanc).
      return hash ? [...WHITE, 255] : [0, 0, 0, 0];
    }
    return hash ? [...WHITE, 255] : [...AUBERGINE, 255];
  });
}

function main() {
  const outDir = path.join(__dirname, "..", "public", "icons");
  fs.mkdirSync(outDir, { recursive: true });
  const targets = [
    { file: "icon-192.png", size: 192, opts: {} },
    { file: "icon-512.png", size: 512, opts: {} },
    { file: "icon-512-maskable.png", size: 512, opts: { maskable: true } },
    { file: "badge-72.png", size: 72, opts: { monochrome: true } },
  ];
  for (const t of targets) {
    const out = path.join(outDir, t.file);
    fs.writeFileSync(out, pngHashOnAubergine(t.size, t.opts));
    console.log(`  wrote ${path.relative(process.cwd(), out)}  (${t.size}×${t.size})`);
  }
}

if (require.main === module) {
  main();
}
