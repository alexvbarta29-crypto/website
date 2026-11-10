#!/usr/bin/env node
// Writes the CRM service worker's precache list (design §2.5, §11.1 rule 8).
//
//   node build/crm_precache.mjs           rewrite crm-sw.js: PRECACHE = every
//                                         .js/.css/.svg under crm-app/ (sorted,
//                                         as /crm-app/... URLs), VERSION =
//                                         APP_VERSION from crm-app/version.js
//   node build/crm_precache.mjs --check   exit 1 when crm-sw.js is out of date
//
// Only the integrator runs it, once per merge to the live branch, after
// bumping APP_VERSION; tests/crm/core/precache.test.mjs checks that the
// three agree. Pure file listing: no data, no network.

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const APP_DIR = "crm-app";
export const SW_FILE = "crm-sw.js";
const EXT = new Set([".js", ".css", ".svg"]);

// Every shipped client file as a URL path, sorted.
export function appFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (EXT.has(path.extname(name))) out.push("/" + path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(path.join(root, APP_DIR));
  return out.sort();
}

export function appVersion(root = ROOT) {
  const m = /APP_VERSION\s*=\s*"([^"]+)"/.exec(readFileSync(path.join(root, APP_DIR, "version.js"), "utf8"));
  if (!m) throw new Error("crm-app/version.js has no APP_VERSION");
  return m[1];
}

// The service worker text with VERSION and PRECACHE replaced.
export function rewrite(sw, version, files) {
  const list = "const PRECACHE = [\n" + files.map((f) => `  ${JSON.stringify(f)},`).join("\n") + "\n];";
  let out = sw.replace(/const VERSION = "[^"]*";/, `const VERSION = ${JSON.stringify(version)};`);
  out = out.replace(/const PRECACHE = \[[\s\S]*?\n\];/, list);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const swPath = path.join(ROOT, SW_FILE);
  const sw = readFileSync(swPath, "utf8");
  const next = rewrite(sw, appVersion(), appFiles());
  if (process.argv.includes("--check")) {
    if (next !== sw) { console.error("crm-sw.js is out of date: run node build/crm_precache.mjs"); process.exit(1); }
    console.log("crm-sw.js is up to date");
  } else {
    writeFileSync(swPath, next);
    console.log(`crm-sw.js: VERSION ${appVersion()}, ${appFiles().length} files`);
  }
}
