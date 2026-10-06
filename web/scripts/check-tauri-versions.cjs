"use strict";

/**
 * Vérifie que chaque paquet npm Tauri et sa crate Rust ont le même
 * majeur.mineur — la règle que `tauri build` applique avant de construire
 * (« Found version mismatched Tauri packages »). Dependabot ne relève que le
 * côté npm et la CI des PR ne construit pas l'app desktop : sans ce contrôle,
 * l'écart n'apparaît qu'au tag, dans le job `desktop` de release.yml (c'est ce
 * qui a laissé les releases 1.3.0 et 1.3.1 en brouillon).
 *
 * Paires : `@tauri-apps/api` ↔ `tauri`, `@tauri-apps/plugin-X` ↔ `tauri-plugin-X`,
 * versions lues dans web/package-lock.json et web/src-tauri/Cargo.lock.
 *
 * Lancé par `npm run lint` (web), donc par le job lint de la CI ; seul :
 * `npm run check:tauri` (sortie 1 si écart).
 */

const fs = require("node:fs");
const path = require("node:path");

const web = path.join(__dirname, "..");
const npmLock = JSON.parse(fs.readFileSync(path.join(web, "package-lock.json"), "utf8"));
const cargoLock = fs.readFileSync(path.join(web, "src-tauri", "Cargo.lock"), "utf8");

const crates = new Map();
for (const m of cargoLock.matchAll(/^name = "([^"]+)"\r?\nversion = "([^"]+)"/gm)) {
  crates.set(m[1], m[2]);
}

const majorMinor = (v) => v.split(".").slice(0, 2).join(".");
const mismatched = [];
for (const [key, pkg] of Object.entries(npmLock.packages)) {
  const m = key.match(/^node_modules\/@tauri-apps\/(api|plugin-[a-z0-9-]+)$/);
  if (!m) continue;
  const crate = m[1] === "api" ? "tauri" : `tauri-${m[1]}`;
  const crateVersion = crates.get(crate);
  if (!crateVersion) continue; // paquet npm sans crate correspondante
  const ok = majorMinor(pkg.version) === majorMinor(crateVersion);
  console.log(`${ok ? "ok" : "KO"}  @tauri-apps/${m[1]} ${pkg.version}  ↔  ${crate} ${crateVersion}`);
  if (!ok) mismatched.push({ crate, target: pkg.version });
}

if (mismatched.length) {
  // `--precise` : sans lui, cargo prendrait la dernière 2.x, souvent plus
  // récente que le paquet npm. Rust n'étant pas forcément installé, la commande
  // passe par l'image Docker officielle.
  const updates = mismatched.map(({ crate, target }) => `cargo update -p ${crate} --precise ${target}`);
  console.error(
    "\nÉcart npm/Rust : `tauri build` refusera de construire l'app desktop. Aligner web/src-tauri/Cargo.lock :\n" +
      `  docker run --rm --user "$(id -u):$(id -g)" -e CARGO_HOME=/tmp/cargo -v "$PWD/web/src-tauri:/app" -w /app rust:1-slim sh -c '${updates.join(" && ")}'\n` +
      "(une crate peut ne pas exister en version exacte : prendre alors le dernier correctif du même majeur.mineur)"
  );
  process.exit(1);
}
