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
const REAL_BARE = "612" + "8675309";             // a bare Minnesota number (a CSV export)
const OTHER_BARE = "820" + "9376313";            // a bare 10-digit run outside Minnesota (an id)
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
const gzip = (text) => spawnSync("gzip", ["-c"], { input: text }).stdout;
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
    "tests/bare.mjs": `const row = { phone: "${OTHER_BARE}" };\n`,
    "tests/bare-id.mjs": `const row = { id: "${OTHER_BARE}" };\n`,
    "tests/rows.mjs": `export default "Jane Doe,${REAL_BARE},12 Elm St\\nJohn Roe,1${REAL_BARE},3 Oak Ave";\n`,
    "build/email.mjs": `const to = "${REAL_EMAIL}";\n`,
    "netlify/lib/keys.mjs": `const a = "${STRIPE_SECRET}"; const b = "${STRIPE_CUSTOMER}"; const c = "${TWILIO_SID}";\n`,
    "public-page.html": `<p>${REAL_PHONE}</p>\n`,
    "admin/customers.html": `<td>Jane Doe</td><td>${REAL_EMAIL}</td>\n`,
    "config/export.json": `{"to":"${REAL_EMAIL}"}\n`,
    "notes.md": `call ${REAL_PHONE}\n`,
    "tests/fixtures/customers.csv": `name,phone\nJane Doe,(763) 555-0100\n`,
    "tests/fixtures/export.jsonl.gz": gzip(`{"phone":"${REAL_PHONE}"}\n`),
    "backup.zip": "PK",
    "tests/customers.txt": Buffer.from(`name\tphone\nJane Doe\t${REAL_PHONE}\n`, "utf16le"),
    "tests/customers-bom.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`to ${REAL_EMAIL}\n`, "utf16le")]),
    "assets/brand-kit.zip": "PK",
  });
  try {
    const found = scan.scanTree(dir);
    const SHEET = "spreadsheet or archive (a possible data export)";
    assert.deepEqual(kinds(found), [
      "admin/customers.html email address",
      `backup.zip ${SHEET}`,
      "build/email.mjs email address",
      "config/export.json email address",
      "docs/notes.md phone number",
      "netlify/data/customers.json file in netlify/data/ (only the sealed dashboard snapshot may live there)",
      "netlify/lib/keys.mjs stripe-customer-id",
      "netlify/lib/keys.mjs stripe-live-secret",
      "netlify/lib/keys.mjs twilio-account-sid",
      "notes.md phone number",
      "public-page.html phone number",
      "rotor-export.sealed.json sealed export file",
      "tests/bare.mjs phone number",
      "tests/customers-bom.txt email address",
      "tests/customers.txt phone number",
      "tests/e164.mjs phone number",
      "tests/fixtures/customers.csv " + SHEET,
      "tests/fixtures/export.jsonl .jsonl file (data export)",
      "tests/fixtures/export.jsonl.gz .jsonl file (data export)",
      "tests/rows.mjs phone number",
      "tests/rows.mjs phone number",
    ], "every text file is read, UTF-16 too; a bare id outside Minnesota is not a phone; assets/ may hold archives");
    assert.equal(found.find((f) => f.file === "docs/notes.md").line, 1);
    const cli = spawnSync(process.execPath, [path.join(ROOT, "build/no_data_scan.mjs"), "--root", dir], { encoding: "utf8" });
    assert.equal(cli.status, 1);
    for (const v of [REAL_PHONE, REAL_E164, REAL_BARE, OTHER_BARE, REAL_EMAIL, STRIPE_SECRET, STRIPE_CUSTOMER, TWILIO_SID]) {
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
    "id: 4294967296", "\"id\": \"8209376313\"", "1731234567890", "7631234567", "6120000000",
    "7635550100", "17635550100", "7633143400",
  ];
  for (const v of ok) assert.deepEqual(scan.scanText(v), [], v);
  assert.equal(scan.scanText(`tel:${REAL_E164}`).length, 1);
  assert.equal(scan.scanText(`Phone: ${OTHER_BARE}`).length, 1);
  assert.equal(scan.scanText(`Jane Doe,${REAL_BARE},12 Elm St`).length, 1, "a bare Minnesota number needs no label");
  assert.equal(scan.scanText(`Jane Doe\t1${REAL_BARE}`).length, 1);
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

// A throwaway repository with a bare remote (all in the OS temp dir).
function gitLab() {
  const base = mkdtempSync(path.join(os.tmpdir(), "no-data-git-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: base, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_") && !["GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"].includes(k)) delete env[k];
  const run = (cwd, ...args) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
  const remote = path.join(base, "remote.git");
  const work = path.join(base, "work");
  run(base, "init", "-q", "--bare", remote);
  run(base, "init", "-q", "-b", "main", work);
  run(work, "remote", "add", "origin", remote);
  const commit = (rel, text, message) => {
    if (text === null) rmSync(path.join(work, rel)); else { mkdirSync(path.dirname(path.join(work, rel)), { recursive: true }); writeFileSync(path.join(work, rel), text); }
    run(work, "add", "-A");
    run(work, "commit", "-q", "-m", message);
    return run(work, "rev-parse", "HEAD").stdout.trim();
  };
  return { base, env, run, remote, work, commit, done: () => rmSync(base, { recursive: true, force: true }) };
}

test("CI: a new branch or a force push scans every commit not on another branch (add-then-remove history fails)", (t) => {
  if (spawnSync("git", ["--version"]).status !== 0) { t.skip("git is not installed"); return; }
  const g = gitLab();
  const ZEROS = "0".repeat(40);
  try {
    g.commit("README.md", "Clean start\n", "Clean start");
    assert.equal(g.run(g.work, "push", "-q", "origin", "main").status, 0);
    g.run(g.work, "checkout", "-q", "-b", "feature/leak");
    const added = g.commit("tests/leak.mjs", `export const to = "${REAL_EMAIL}";\n`, "Add");
    const head = g.commit("tests/leak.mjs", null, "Remove");
    assert.equal(g.run(g.work, "push", "-q", "origin", "feature/leak").status, 0);
    g.run(g.work, "fetch", "-q", "origin");                     // as actions/checkout leaves it: origin/feature/leak = head
    assert.deepEqual(scan.scanTree(g.work), [], "the tree alone is clean");
    for (const base of [ZEROS, "2".repeat(40)]) {
      const found = scan.scanRange(g.work, `${base}..${head}`, { excludeRef: "feature/leak" });
      assert.deepEqual(kinds(found), [`tests/leak.mjs (commit ${added.slice(0, 10)}) email address`], base);
      assert.equal(scan.scanRange(g.work, `${base}..${head}`).length, 1, "without --exclude-ref: every commit of head");
    }
    const cli = spawnSync(process.execPath, [path.join(ROOT, "build/no_data_scan.mjs"), "--root", g.work, "--range", `${ZEROS}..${head}`, "--exclude-ref", "feature/leak"], { encoding: "utf8" });
    assert.equal(cli.status, 1, cli.stdout + cli.stderr);
    // a clean new branch passes, and only its own commits are read
    g.run(g.work, "checkout", "-q", "main");
    g.run(g.work, "checkout", "-q", "-b", "feature/clean");
    const clean = g.commit("notes.txt", "Call (763) 314-3400.\n", "Notes");
    g.run(g.work, "push", "-q", "origin", "feature/clean");
    g.run(g.work, "fetch", "-q", "origin");
    assert.deepEqual(scan.scanRange(g.work, `${ZEROS}..${clean}`, { excludeRef: "feature/clean" }), []);
  } finally {
    g.done();
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

    // a new branch whose history added then removed a fixture is blocked, even when
    // another remote already has those commits
    run(work, "checkout", "-q", "-b", "feature/leak");
    writeFileSync(path.join(work, "leak.mjs"), `export const to = "${REAL_EMAIL}";\n`);
    run(work, "add", "-A");
    run(work, "commit", "-q", "-m", "Add");
    rmSync(path.join(work, "leak.mjs"));
    run(work, "add", "-A");
    run(work, "commit", "-q", "-m", "Remove");
    const nb = run(work, "push", "origin", "feature/leak");
    assert.notEqual(nb.status, 0, "new branch with data in its history");
    assert.match(nb.stderr, /leak\.mjs \(commit [0-9a-f]+\):1 {2}email address/);
    run(work, "update-ref", "refs/remotes/mirror/feature/leak", "HEAD");
    assert.notEqual(run(work, "push", "origin", "feature/leak").status, 0, "a commit another remote has is still new to origin");

    // a clean new branch goes through, and deleting a branch is never blocked
    run(work, "checkout", "-q", "main");
    run(work, "checkout", "-q", "-b", "feature/clean");
    writeFileSync(path.join(work, "clean.txt"), "nothing personal\n");
    run(work, "add", "-A");
    run(work, "commit", "-q", "-m", "Clean");
    const cleanPush = run(work, "push", "origin", "feature/clean");
    assert.equal(cleanPush.status, 0, cleanPush.stderr);
    const del = run(work, "push", "origin", "--delete", "feature/clean");
    assert.equal(del.status, 0, del.stderr);

    // a force push over a remote tip this clone never fetched: scanned, with a note, not a crash
    const other = path.join(base, "other");
    assert.equal(run(base, "clone", "-q", "-b", "main", remote, other).status, 0);
    writeFileSync(path.join(other, "theirs.txt"), "theirs\n");
    run(other, "add", "-A");
    run(other, "commit", "-q", "-m", "Theirs");
    const theirs = run(other, "push", "-q", "origin", "main");
    assert.equal(theirs.status, 0, theirs.stderr);
    run(work, "checkout", "-q", "main");
    writeFileSync(path.join(work, "mine.txt"), "mine\n");
    run(work, "add", "-A");
    run(work, "commit", "-q", "-m", "Mine");
    const forced = run(work, "push", "--force", "origin", "main");
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stderr, /is not in this clone/);
    writeFileSync(path.join(work, "mine.txt"), `call ${REAL_PHONE}\n`);
    run(work, "add", "-A");
    run(work, "commit", "-q", "-m", "Mine again");
    run(other, "commit", "-q", "--allow-empty", "-m", "Theirs again");
    run(other, "push", "-q", "--force", "origin", "HEAD:main");
    const forcedLeak = run(work, "push", "--force", "origin", "main");
    assert.notEqual(forcedLeak.status, 0, "a force push with data is still blocked");
    assert.match(forcedLeak.stderr, /mine\.txt \(commit [0-9a-f]+\):1 {2}phone number/);
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
  assert.match(wf, /--range "\$BEFORE\.\.\$AFTER" --exclude-ref "\$BRANCH"/);
  assert.ok(!/event\.before != /.test(wf), "a new branch is scanned too, not skipped");
  assert.match(wf, /--range "\$BASE\.\.\$HEAD"/);
  assert.match(wf, /permissions:\n {2}contents: read/);
});
