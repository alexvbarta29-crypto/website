// The CRM's server code reads the time from the core clock only
// (netlify/lib/crm/core/clock.mjs: now(), nowMs(), nowIso()), so a test can
// pin it and a sweep, a deadline or a stamp never drifts from the rest of
// a request. new Date(x) to parse a value is fine; new Date() and
// Date.now() (the wall clock) are not. Found in review (M4b): the tech
// day's generated_at read the wall clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// files that may read the wall clock, and why
const ALLOW = new Map([
  ["netlify/lib/crm/core/clock.mjs", "the clock itself"],
]);
const WALL = /\bDate\.now\(\s*\)|\bnew Date\(\s*\)/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
// the code of a line, without a trailing // comment (a plain heuristic: these files keep comments on their own lines or after code)
const code = (line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line.replace(/\s\/\/\s.*$/, ""));

test("no CRM server code reads the wall clock outside core/clock.mjs", () => {
  const files = [
    ...walk(path.join(ROOT, "netlify/lib/crm")),
    ...readdirSync(path.join(ROOT, "netlify/functions")).filter((n) => /^crm.*\.mjs$/.test(n)).map((n) => path.join(ROOT, "netlify/functions", n)),
  ];
  assert.ok(files.length > 50, "the CRM's server files were found");
  const hits = [];
  for (const f of files) {
    if (ALLOW.has(rel(f))) continue;
    readFileSync(f, "utf8").split("\n").forEach((line, i) => { if (WALL.test(code(line))) hits.push(`${rel(f)}:${i + 1}: ${line.trim()}`); });
  }
  assert.deepEqual(hits, [], "use now(), nowMs() or nowIso() from core/clock.mjs");
});
