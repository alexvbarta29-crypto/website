#!/usr/bin/env node
// No customer data in git, ever (design §0 rule 1, §12.5). One scanner, three
// guards: the pre-push hook (.githooks/pre-push, installed by `npm install`
// through the "prepare" script), the GitHub workflow (.github/workflows/
// no-data.yml, every push to any branch) and npm test (tests/crm/no-data
// .test.mjs).
//
//   node build/no_data_scan.mjs                 scan the working tree: every file (tracked and
//                                               new, not ignored; binaries by path only)
//   node build/no_data_scan.mjs --root DIR      the same for another directory (git or not)
//   node build/no_data_scan.mjs --push [REMOTE URL]
//                                               pre-push: read "<local ref> <sha> <remote ref> <sha>"
//                                               lines on stdin and scan every outgoing commit (a new
//                                               branch: every commit not already on REMOTE)
//   node build/no_data_scan.mjs --range A..B [--exclude-ref NAME] [--remote origin]
//                                               scan the commits in A..B (CI). When A is all zeros
//                                               (a new branch) or not in the clone (a force push):
//                                               every commit of B not on another branch of the
//                                               remote (NAME = the pushed branch), or, without
//                                               --exclude-ref, every commit of B
//
// It fails (exit 1) on:
//   - anything in netlify/data/ except office-dashboard.sealed.mjs; any .jsonl or *.sealed.json
//     file, also compressed (.jsonl.gz); spreadsheets and archives (.csv .tsv .xlsx .xls .numbers
//     .ods .zip .gz .7z ...) outside assets/ unless EXPORT_FILES_ALLOWED names them
//   - a phone number outside 555 and the business's own numbers ((763) 314-3400, (763) 309-9790,
//     in their usual spellings): formatted or +1 numbers anywhere; bare 10-digit (or 1 + 10)
//     runs with a Minnesota area code (218 320 507 612 651 763 952) anywhere; other bare runs
//     right after a word like "phone" or "tel"
//   - an email outside example.com and bartawindowwashing.com (plus the reserved .test /
//     .invalid / .example names and two form placeholders already in the site)
//   - Stripe/Twilio secret or id shapes (live secret and restricted keys, customer ids, account SIDs)
// in every text file (UTF-8 or UTF-16), and in --push / --range mode also on commit messages
// (trailer lines like Co-Authored-By are skipped: they name authors, not customers). Findings
// print as path:line and a kind, never the matched text. Exit 2 = the scan itself could not run.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The folders design §12.5 names. The scan now reads every text file in the
// repository, these included (a customer list saved anywhere must fail).
export const SCAN_DIRS = ["netlify", "crm-app", "tests", "docs", "build"];
export const DATA_DIR_ALLOWED = ["office-dashboard.sealed.mjs"];
// Exact repo-relative paths of spreadsheets or archives that are allowed
// (none today; a synthetic fixture would be added here by name).
export const EXPORT_FILES_ALLOWED = [];
export const BUSINESS_PHONES = ["7633143400", "7633099790"];
export const MN_AREA_CODES = ["218", "320", "507", "612", "651", "763", "952"];
export const EMAIL_DOMAINS = ["example.com", "bartawindowwashing.com"];
export const RESERVED_TLDS = ["test", "invalid", "example"];
// Generic form placeholders that were on the site before this scan existed.
export const PLACEHOLDER_EMAILS = ["you@email.com", "someone@else.com"];

const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|heic|woff2?|ttf|otf|eot|mp4|mov|webm|mp3|wav|pdf|zip|gz|tgz|br|pem|der|p12|pfx|bin|wasm)$/i;

// Phone shapes: optional +1, area code (bare or in parentheses), exchange, line.
const PHONE_RE = /(?<![\w.+])(\+?1[\s.-]?)?(\((\d{3})\)|(\d{3}))([\s.-]?)(\d{3})([\s.-]?)(\d{4})(?![\w])/g;
const PHONE_CONTEXT = /(phone|tel|mobile|cell|sms|whatsapp|contact)[^\n]{0,24}$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Built from parts so this file never matches itself.
const SECRET_RES = [
  ["stripe-live-secret", new RegExp("\\b(?:s|r)k" + "_live_[A-Za-z0-9]{8,}")],
  ["stripe-customer-id", new RegExp("\\bcus" + "_[A-Za-z0-9]{14}\\b")],
  ["twilio-account-sid", new RegExp("\\bA" + "C[0-9a-f]{32}\\b")],
];
const TRAILER_RE = /^(co-authored-by|signed-off-by|claude-session|reviewed-by|acked-by|helped-by):/i;

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// Content findings of one text: [{ line, kind }].
export function scanText(text) {
  const out = [];
  for (const m of text.matchAll(PHONE_RE)) {
    const area = m[3] || m[4];
    const exchange = m[6];
    const digits = area + exchange + m[8];
    const formatted = !!((m[1] && /[+\s.-]/.test(m[1])) || m[3] || m[5] || m[7]);   // a bare leading 1 is not formatting
    if (area === "555" || exchange === "555" || BUSINESS_PHONES.includes(digits)) continue;
    // a bare run counts when it is a Minnesota number (area code + an exchange 2-9xx: a CSV
    // export) or when a word like "phone" comes right before it
    const minnesota = MN_AREA_CODES.includes(area) && /^[2-9]/.test(exchange);
    if (!formatted && !minnesota && !PHONE_CONTEXT.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
    out.push({ line: lineOf(text, m.index), kind: "phone number" });
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    const addr = m[0].toLowerCase();
    const domain = addr.slice(addr.lastIndexOf("@") + 1);
    const tld = domain.slice(domain.lastIndexOf(".") + 1);
    const ok = EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith("." + d)) || RESERVED_TLDS.includes(tld)
      || ["example.org", "example.net"].includes(domain) || PLACEHOLDER_EMAILS.includes(addr);
    if (!ok) out.push({ line: lineOf(text, m.index), kind: "email address" });
  }
  for (const [kind, re] of SECRET_RES) {
    for (const m of text.matchAll(new RegExp(re.source, "g"))) out.push({ line: lineOf(text, m.index), kind });
  }
  return out;
}

const EXPORT_EXT = /\.(csv|tsv|xlsx|xlsm|xls|numbers|ods|zip|gz|tgz|7z|rar|tar|bz2|xz)$/i;

// Path findings of one repo-relative path: [kind].
export function scanPath(rel) {
  const p = rel.split(path.sep).join("/");
  const out = [];
  if (/\.jsonl(\.[a-z0-9]+)?$/i.test(p)) out.push(".jsonl file (data export)");
  if (/\.sealed\.json(\.[a-z0-9]+)?$/i.test(p)) out.push("sealed export file");
  if (p.startsWith("netlify/data/") && !DATA_DIR_ALLOWED.includes(p.slice("netlify/data/".length))) out.push("file in netlify/data/ (only the sealed dashboard snapshot may live there)");
  if (EXPORT_EXT.test(p) && !p.startsWith("assets/") && !EXPORT_FILES_ALLOWED.includes(p) && !out.length) out.push("spreadsheet or archive (a possible data export)");
  return out;
}

// The text of a file, or null for a binary one: UTF-8, or UTF-16 (a BOM, or
// a NUL in every other byte: Excel "Unicode text", PowerShell output).
export function decodeText(rel, buf) {
  if (BINARY_EXT.test(rel) || !buf) return null;
  const head = buf.subarray(0, 8000);
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  if (!head.includes(0)) return buf.toString("utf8");
  const even = head.length >= 4 && head.length % 2 === 0 ? head : head.subarray(0, head.length - (head.length % 2));
  let oddNul = 0;
  let evenNul = 0;
  for (let i = 0; i < even.length; i += 2) { if (even[i] === 0) evenNul++; if (even[i + 1] === 0) oddNul++; }
  const pairs = even.length / 2;
  if (pairs >= 2 && oddNul === pairs && evenNul === 0) return buf.subarray(0, buf.length - (buf.length % 2)).toString("utf16le");
  if (pairs >= 2 && evenNul === pairs && oddNul === 0) return Buffer.from(buf.subarray(0, buf.length - (buf.length % 2))).swap16().toString("utf16le");
  return null;
}

function git(root, args, input) {
  return execFileSync("git", args, { cwd: root, encoding: "buffer", maxBuffer: 256 * 1024 * 1024, input, stdio: ["pipe", "pipe", "ignore"] });
}
const gitText = (root, args, input) => git(root, args, input).toString("utf8");
function isGitTree(root) {
  try { return gitText(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true"; } catch { return false; }
}

function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(path.join(root, dir))) {
      if (name === ".git" || name === "node_modules" || name === "_deploy") continue;
      const rel = dir ? `${dir}/${name}` : name;
      const st = statSync(path.join(root, rel));
      if (st.isDirectory()) visit(rel); else if (st.isFile()) out.push(rel);
    }
  };
  visit("");
  return out;
}

// The working tree: path rules and content rules on every file (binaries by path only).
export function scanTree(root) {
  const files = isGitTree(root)
    ? gitText(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean)
    : walk(root);
  const findings = [];
  for (const rel of [...new Set(files)].sort()) {
    if (rel.split("/").includes("node_modules")) continue;
    for (const kind of scanPath(rel)) findings.push({ file: rel, line: 0, kind });
    if (BINARY_EXT.test(rel)) continue;
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue;            // deleted in the working tree
    let buf;
    try { if (!statSync(abs).isFile()) continue; buf = readFileSync(abs); } catch { continue; }
    const text = decodeText(rel, buf);
    if (text === null) continue;
    for (const f of scanText(text)) findings.push({ file: rel, ...f });
  }
  return findings;
}

const ZERO = /^0+$/;
const SAFE_REMOTE = /^[A-Za-z0-9._-]+$/;
const revList = (root, args) => gitText(root, ["rev-list", ...args]).split("\n").filter(Boolean);
function hasCommit(root, sha) {
  try { git(root, ["cat-file", "-e", `${sha}^{commit}`]); return true; } catch { return false; }
}

// Every commit of `head` that the remote does not have on any branch
// (`exclude`: a branch of the remote to leave out, the one being pushed).
// Without a usable remote name: every commit of head.
function newOnRemote(root, head, remote, exclude) {
  if (!remote || !SAFE_REMOTE.test(remote)) return revList(root, [head]);
  return revList(root, [head, "--not", ...(exclude ? [`--exclude=${remote}/${exclude}`] : []), `--remotes=${remote}`]);
}

// Commits being pushed for one pre-push line, newest first.
function outgoing(root, localSha, remoteSha, remote) {
  if (ZERO.test(localSha)) return [];                       // a branch deletion
  if (!ZERO.test(remoteSha)) {
    if (hasCommit(root, remoteSha)) return revList(root, [`${remoteSha}..${localSha}`]);
    console.error(`no-data scan: the remote's tip ${remoteSha.slice(0, 10)} is not in this clone (a force push without fetching first?); scanning every commit not already on ${remote || "the remote"}`);
  }
  return newOnRemote(root, localSha, remote, null);         // a new branch
}

// Every outgoing commit: its message, and each file it adds or changes (for
// a merge, only what differs from every parent), read from that commit.
export function scanCommits(root, shas) {
  const findings = [];
  for (const sha of shas) {
    const short = sha.slice(0, 10);
    const message = gitText(root, ["log", "-1", "--format=%B", sha]).split("\n").filter((l) => !TRAILER_RE.test(l.trim())).join("\n");
    for (const f of scanText(message)) findings.push({ file: `commit ${short} message`, line: f.line, kind: f.kind });
    const parents = gitText(root, ["rev-list", "--parents", "-n", "1", sha]).trim().split(" ").slice(1);
    const listArgs = parents.length > 1
      ? ["diff-tree", "-r", "-c", "--no-commit-id", "--name-only", "--diff-filter=ACMRT", sha]
      : ["diff-tree", "-r", "--root", "--no-commit-id", "--name-only", "--diff-filter=ACMRT", sha];
    const files = [...new Set(gitText(root, listArgs).split("\n").filter(Boolean))];
    for (const rel of files) {
      for (const kind of scanPath(rel)) findings.push({ file: `${rel} (commit ${short})`, line: 0, kind });
      if (BINARY_EXT.test(rel)) continue;
      let buf;
      try { buf = git(root, ["cat-file", "blob", `${sha}:${rel}`]); } catch { continue; }
      const text = decodeText(rel, buf);
      if (text === null) continue;
      for (const f of scanText(text)) findings.push({ file: `${rel} (commit ${short})`, ...f });
    }
  }
  return findings;
}

// opts.remote: the remote's name (git gives it to the hook as $1).
export function scanPushInput(root, stdinText, { remote = null } = {}) {
  const shas = new Set();
  for (const line of String(stdinText).split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    for (const sha of outgoing(root, parts[1], parts[3], remote)) shas.add(sha);
  }
  return scanCommits(root, [...shas]);
}

// The commits of a push in CI. A base that is all zeros (a new branch) or not
// in the clone (a force push) falls back to every commit of head that is not
// on another branch of the remote; without excludeRef (the pushed branch,
// whose remote ref already points at head) to every commit of head.
export function scanRange(root, range, { excludeRef = null, remote = "origin" } = {}) {
  if (!/^[0-9a-f]{4,64}\.\.[0-9a-f]{4,64}$/i.test(range)) throw new Error("--range takes <sha>..<sha>");
  const [base, head] = range.split("..");
  if (!hasCommit(root, head)) throw new Error("the pushed commit is not in this clone");
  if (!ZERO.test(base) && hasCommit(root, base)) return scanCommits(root, revList(root, [range]));
  const shas = excludeRef ? newOnRemote(root, head, remote, excludeRef) : revList(root, [head]);
  return scanCommits(root, shas);
}

function report(findings, what) {
  if (!findings.length) { console.log(`no-data scan: no findings in ${what}`); return 0; }
  console.error(`no-data scan: ${findings.length} finding${findings.length === 1 ? "" : "s"} in ${what} (values not shown):`);
  for (const f of findings.slice(0, 200)) console.error(`  ${f.file}${f.line ? ":" + f.line : ""}  ${f.kind}`);
  if (findings.length > 200) console.error(`  … and ${findings.length - 200} more`);
  console.error("Customer data must never be committed. Use synthetic fixtures (555 numbers, example.com emails); real exports stay outside every worktree.");
  return 1;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function main(argv = process.argv.slice(2), stdin = null) {
  let root = path.resolve(HERE, "..");
  let mode = "tree";
  let range = null;
  let excludeRef = null;
  let remote = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") root = path.resolve(argv[++i] || "");
    else if (a === "--push") mode = "push";
    else if (a === "--range") { mode = "range"; range = argv[++i] || ""; }
    else if (a === "--exclude-ref") excludeRef = argv[++i] || null;
    else if (a === "--remote") remote = argv[++i] || null;
    else if (a === "--help" || a === "-h") { console.log("usage: node build/no_data_scan.mjs [--root DIR] [--push [REMOTE URL] | --range A..B [--exclude-ref NAME] [--remote NAME]]"); return 0; }
    else if (mode === "push" && !a.startsWith("-")) positional.push(a);   // git passes the remote name and URL
    else { console.error(`no-data scan: unknown argument ${a}`); return 2; }
  }
  if (!existsSync(root)) { console.error("no-data scan: no such directory"); return 2; }
  try {
    if (mode === "push") return report(scanPushInput(root, stdin ?? readFileSync(0, "utf8"), { remote: remote || positional[0] || null }), "the outgoing commits");
    if (mode === "range") return report(scanRange(root, range, { excludeRef, remote: remote || "origin" }), `the pushed commits (${range})`);
    return report(scanTree(root), "the working tree");
  } catch (e) {
    console.error("no-data scan: could not run (" + (e && e.message ? String(e.message).slice(0, 200) : e) + ")");
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
