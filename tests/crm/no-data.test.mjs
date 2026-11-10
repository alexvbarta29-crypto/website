// No customer data in git, ever (design §0 rule 1, §12.5, §11.4 M1.1): the
// repo passes the scan; planted fixtures fail it; the business allowlist and
// synthetic values pass; the pre-push hook blocks a push that carries data;
// the workflow and the npm scripts are wired. Every "real-looking" value
// below is assembled at run time in a temp directory outside the repo, so
// this file itself stays clean.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, chmodSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const scan = await import("../../build/no_data_scan.mjs");
const ROOT = path.resolve(import.meta.dirname, "../..");

// Values that look real, built from pieces (never written in this file whole).
const REAL_PHONE = ["(612)", "867-" + "5309"].join(" ");
const REAL_E164 = "+1" + "612" + "8675309";
const REAL_BARE = "612" + "8675309";
const REAL_EMAIL = "jane.doe" + "@" + "gmail.com";
const STRIPE_SECRET = "sk" + "_live_" + "0123456789abcdefABCDEF";
const STRIPE_CUSTOMER = "cus" + "_" + "AbCdEfGhIjKlMn";
const TWILIO_SID = "A" + "C" + "0123456789abcdef0123456789abcdef";

function tempTree(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "no-data-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const kinds = (findings) => findings.map((f) => `${f.file} ${f.kind}`).sort();

test("the repository as it is passes the scan", () => {
  assert.deepEqual(scan.scanTree(ROOT), []);
});

test("planted fixtures fail, one finding each, and the CLI never prints the values", () => {
  const dir = tempTree({
    "netlify/data/office-dashboard.sealed.mjs": "export default {};\n",
    "netlify/data/customers.json": "{}\n",
    "tests/fixtures/export.jsonl": "{}\n",
    "rotor-export.sealed.json": "{}\n",
    "docs/notes.md": `Call ${REAL_PHONE} about the gutters.\n`,
    "tests/e164.mjs": `const to = "${REAL_E164}";\n`,
    "tests/bare.mjs": `const row = { phone: "${REAL_BARE}" };\n`,
    "tests/bare-id.mjs": `const row = { id: "${REAL_BARE}" };\n`,
    "build/email.mjs": `const to = "${REAL_EMAIL}";\n`,
    "netlify/lib/keys.mjs": `const a = "${STRIPE_SECRET}"; const b = "${STRIPE_CUSTOMER}"; const c = "${TWILIO_SID}";\n`,
    "public-page.html": `<p>${REAL_PHONE}</p>\n`,
  });
  try {
    const found = scan.scanTree(dir);
    assert.deepEqual(kinds(found), [
      "build/email.mjs email address",
      "docs/notes.md phone number",
      "netlify/data/customers.json file in netlify/data/ (only the sealed dashboard snapshot may live there)",
      "netlify/lib/keys.mjs stripe-customer-id",
      "netlify/lib/keys.mjs stripe-live-secret",
      "netlify/lib/keys.mjs twilio-account-sid",
      "rotor-export.sealed.json sealed export file",
      "tests/bare.mjs phone number",
      "tests/e164.mjs phone number",
      "tests/fixtures/export.jsonl .jsonl file (data export)",
    ], "a bare 10-digit id is not a phone; public pages outside the scanned folders are left to the bots");
    assert.equal(found.find((f) => f.file === "docs/notes.md").line, 1);
    const cli = spawnSync(process.execPath, [path.join(ROOT, "build/no_data_scan.mjs"), "--root", dir], { encoding: "utf8" });
    assert.equal(cli.status, 1);
    for (const v of [REAL_PHONE, REAL_E164, REAL_BARE, REAL_EMAIL, STRIPE_SECRET, STRIPE_CUSTOMER, TWILIO_SID]) {
      assert.ok(!(cli.stdout + cli.stderr).includes(v), "the scan never echoes a value");
    }
    assert.match(cli.stderr, /docs\/notes\.md:1 {2}phone number/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the business numbers, 555 numbers and synthetic emails pass", () => {
  const ok = [
    "(763) 314-3400", "763-314-3400", "+17633143400", "(763) 309-9790", "+17633099790",
    "(763) 555-0100", "+17635550100", "763-555-0199", "+15550100123", "phone: \"7635550101\"",
    "pat@example.com", "office@bartawindowwashing.com", "x@mail.example.com", "a@b.test",
    "id: 4294967296", "\"id\": \"8209376313\"", "1731234567890",
  ];
  for (const v of ok) assert.deepEqual(scan.scanText(v), [], v);
  assert.equal(scan.scanText(`tel:${REAL_E164}`).length, 1);
  assert.equal(scan.scanText(`Phone: ${REAL_BARE}`).length, 1);
});

test("the CLI: exit 0 when clean, 2 when it cannot run", () => {
  const dir = tempTree({ "docs/ok.md": "Call (763) 314-3400.\n" });
  try {
    assert.equal(spawnSync(process.execPath, [path.join(ROOT, "build/no_data_scan.mjs"), "--root", dir]).status, 0);
    assert.equal(spawnSync(process.execPath, [path.join(ROOT, "build/no_data_scan.mjs"), "--bogus"]).status, 2);
    assert.equal(spawnSync(process.execPath, [path.join(ROOT, "build/no_data_scan.mjs"), "--range", "HEAD"], { cwd: dir }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pre-push hook blocks a push that carries customer data, in a file, a commit message or history", (t) => {
  const git = spawnSync("git", ["--version"]);
  if (git.status !== 0) { t.skip("git is not installed"); return; }
  const base = mkdtempSync(path.join(os.tmpdir(), "no-data-hook-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: base, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_") && !["GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"].includes(k)) delete env[k];
  const run = (cwd, ...args) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
  const remote = path.join(base, "remote.git");
  const work = path.join(base, "work");
  try {
    assert.equal(run(base, "init", "-q", "--bare", remote).status, 0);
    assert.equal(run(base, "init", "-q", "-b", "main", work).status, 0);
    mkdirSync(path.join(work, "build"));
    mkdirSync(path.join(work, ".githooks"));
    copyFileSync(path.join(ROOT, "build/no_data_scan.mjs"), path.join(work, "build/no_data_scan.mjs"));
    copyFileSync(path.join(ROOT, ".githooks/pre-push"), path.join(work, ".githooks/pre-push"));
    chmodSync(path.join(work, ".githooks/pre-push"), 0o755);
    run(work, "config", "core.hooksPath", ".githooks");
    run(work, "remote", "add", "origin", remote);
    run(work, "add", ".");
    run(work, "commit", "-q", "-m", "Clean start");
    const first = run(work, "push", "-q", "origin", "main");
    assert.equal(first.status, 0, first.stderr);

    // a planted fixture in a file
    mkdirSync(path.join(work, "tests"));
    writeFileSync(path.join(work, "tests/fixture.mjs"), `export const to = "${REAL_EMAIL}";\n`);
    run(work, "add", ".");
    run(work, "commit", "-q", "-m", "Add a fixture");
    const blocked = run(work, "push", "origin", "main");
    assert.notEqual(blocked.status, 0, "the push is refused");
    assert.match(blocked.stderr, /tests\/fixture\.mjs \(commit [0-9a-f]+\):1 {2}email address/);
    assert.ok(!blocked.stderr.includes(REAL_EMAIL));

    // removing it in a later commit does not help: the history still has it
    rmSync(path.join(work, "tests/fixture.mjs"));
    run(work, "add", "-A");
    run(work, "commit", "-q", "-m", "Remove the fixture");
    assert.notEqual(run(work, "push", "origin", "main").status, 0);

    // rewrite to a clean history, then a commit message that carries data
    run(work, "reset", "-q", "--hard", "origin/main");
    writeFileSync(path.join(work, "notes.txt"), "nothing personal\n");
    run(work, "add", ".");
    run(work, "commit", "-q", "-m", `Follow up with ${REAL_PHONE}`);
    const msg = run(work, "push", "origin", "main");
    assert.notEqual(msg.status, 0);
    assert.match(msg.stderr, /message:1 {2}phone number/);

    // a clean commit (with the attribution trailer) goes through
    run(work, "reset", "-q", "--hard", "origin/main");
    writeFileSync(path.join(work, "notes.txt"), "Call (763) 314-3400 or (763) 555-0100.\n");
    run(work, "add", ".");
    run(work, "commit", "-q", "-m", "Notes\n\nCo-Authored-By: Someone <" + "someone" + "@" + "real-company.dev>");
    const ok = run(work, "push", "origin", "main");
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the guards are wired: hook, workflow, npm scripts, Node pin", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, 'node --test "tests/**/*.test.mjs"');
  assert.equal(pkg.scripts["test:crm"], 'node --test "tests/crm/**/*.test.mjs"');
  assert.equal(pkg.scripts.scan, "node build/no_data_scan.mjs");
  assert.match(pkg.scripts.prepare, /rev-parse','--is-inside-work-tree'/);
  assert.match(pkg.scripts.prepare, /core\.hooksPath','\.githooks'/);
  assert.match(pkg.scripts.prepare, /\|\| exit 0$/, "npm install on Netlify must never fail here");
  assert.deepEqual(Object.keys(pkg.dependencies), ["@netlify/blobs"], "one runtime dependency");
  assert.equal(readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim(), "22");
  const hook = readFileSync(path.join(ROOT, ".githooks/pre-push"), "utf8");
  assert.match(hook, /^#!\/bin\/sh/);
  assert.match(hook, /scan="\$root\/build\/no_data_scan\.mjs"/);
  assert.match(hook, /exec node "\$scan" --push "\$@"/);
  assert.ok(statSync(path.join(ROOT, ".githooks/pre-push")).mode & 0o111, "executable");
  const wf = readFileSync(path.join(ROOT, ".github/workflows/no-data.yml"), "utf8");
  assert.match(wf, /branches: \["\*\*"\]/);
  assert.match(wf, /node build\/no_data_scan\.mjs\n/);
  assert.match(wf, /--range "\$BEFORE\.\.\$AFTER"/);
  assert.match(wf, /permissions:\n {2}contents: read/);
});
