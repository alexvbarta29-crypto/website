// Core "system" module: search (design §4.12, §9.1 "Search").
//
//   GET  /search?q=          contacts:read_all   numbers first (Q-18641, INV-0610, D-0001, 0000885 through
//                                                the number pointers), then contacts from the contacts index
//                                                (name, phone, email, address, tags; every word must match)
//   POST /search/deep {q}    contacts:read_all   a bulk-lane run over contact notes and message bodies that
//                                                lists the matching contacts when it finishes
//
// Contacts and their index arrive with M2a; until then the contact part
// answers nothing and the number part only finds what exists.

import { readPointer, readIndex, listKeys, getRecords } from "../../../crm-store.mjs";
import { InputError } from "../../core/errors.mjs";
import { isId, typeOf } from "../../core/ids.mjs";
import { createRun, defineRun, runView } from "../../core/lanes.mjs";
import { contactShard } from "../../core/stats.mjs";

export const MAX_RESULTS = 20;
export const DEEP_MAX = 200;

// What a typed document number names: [{ seq, n, label }] (§3.9 pointers
// ptr/{seq}-no/{n} hold the plain integer).
export function numberCandidates(q) {
  const s = String(q || "").trim().toUpperCase().replace(/\s+/g, "");
  const out = [];
  let m;
  if ((m = /^Q-?(\d{1,9})$/.exec(s))) out.push({ seq: "quote", n: Number(m[1]), label: `Q-${m[1]}` });
  else if ((m = /^(?:INV|IN)-?(\d{1,9})$/.exec(s))) out.push({ seq: "invoice", n: Number(m[1]), label: `INV-${m[1]}` });
  else if ((m = /^D-?(\d{1,9})$/.exec(s))) out.push({ seq: "deposit", n: Number(m[1]), label: `D-${m[1]}` });
  else if ((m = /^#?(\d{3,9})$/.exec(s))) {
    out.push({ seq: "job", n: Number(m[1]), label: m[1] });
    out.push({ seq: "invoice", n: Number(m[1]), label: `INV-${m[1]}` });
    out.push({ seq: "quote", n: Number(m[1]), label: `Q-${m[1]}` });
  }
  return out.filter((c) => Number.isSafeInteger(c.n) && c.n > 0);
}

const words = (q) => String(q || "").toLowerCase().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}@.+-]/gu, "")).filter(Boolean);
const digits = (s) => String(s || "").replace(/\D/g, "");

// Every word of the query must appear in the row's text (phone digits match digits).
export function rowMatches(row, ws) {
  const text = JSON.stringify(row).toLowerCase();
  const d = digits(text);
  return ws.every((w) => text.includes(w) || (/^\d{3,}$/.test(digits(w)) && digits(w).length >= 3 && d.includes(digits(w))));
}

// The contacts index row (M2a, design §3.5): n = display name, f/l = names, co = company, c = town, p = phone digits.
const display = (row) => row.n || row.dn || row.display_name || row.name || [row.f || row.fn || row.first_name, row.l || row.ln || row.last_name].filter(Boolean).join(" ") || row.co || row.company_name || "No name";

async function search(ctx) {
  const q = String(ctx.query.get("q") || "").trim();
  if (q.length < 2) return { data: { numbers: [], contacts: [] } };
  if (q.length > 100) throw new InputError("Search for fewer words.", "q");
  const numbers = [];
  for (const c of numberCandidates(q)) {
    const p = await readPointer(`${c.seq}-no`, String(c.n));
    if (p && isId(p.id)) numbers.push({ type: typeOf(p.id), id: p.id, label: c.label, seq: c.seq });
  }
  const ws = words(q);
  let contacts = [];
  if (ws.length) {
    const shard = contactShard("ct_00000000000000000000");
    const ix = await readIndex("contacts", shard);
    contacts = ix.rows.filter((row) => isId(row.id, "contact") && !row.merged_into && row.lc !== "archived" && rowMatches(row, ws)).slice(0, MAX_RESULTS)
      .map((row) => ({ id: row.id, name: display(row), sub: [row.c || row.town || row.city, (row.p && row.p.length) || row.ph ? "phone on file" : null].filter(Boolean).join(" · ") }));
  }
  return { data: { numbers, contacts } };
}

// ------------------------------------------------------------ deep search (bulk lane)

async function deepStep(run, { budget }) {
  const ws = words(run.input && run.input.q);
  const cp = run.checkpoint && run.checkpoint.phase ? { ...run.checkpoint } : { phase: "contact", after: null, hits: [], scanned: 0 };
  const hits = new Set(cp.hits);
  for (const phase of ["contact", "message"]) {
    if (cp.phase === "done") break;
    if (phase === "contact" && cp.phase !== "contact") continue;
    const keys = (await listKeys(`rec/${phase}/`)).filter((k) => cp.after === null || k > cp.after);
    for (let i = 0; i < keys.length; i += 16) {
      if ((budget && budget.left() < 15000) || hits.size >= DEEP_MAX) return { checkpoint: { ...cp, hits: [...hits] }, progress: { done: cp.scanned, total: null } };
      const chunk = keys.slice(i, i + 16);
      const ids = chunk.map((k) => k.split("/").pop()).filter((id) => isId(id, phase));
      const got = await getRecords(phase, ids);
      for (const g of got) {
        const rec = g && g.data;
        if (!rec || rec.deleted_at) continue;
        const text = phase === "contact" ? `${rec.notes || ""} ${rec.first_name || ""} ${rec.last_name || ""} ${rec.company_name || ""}` : `${rec.body_text || ""} ${rec.subject || ""}`;
        if (ws.length && rowMatches({ t: text }, ws)) hits.add(phase === "contact" ? rec.id : rec.contact_id);
      }
      cp.scanned += chunk.length;
      cp.after = chunk[chunk.length - 1];
    }
    cp.phase = phase === "contact" ? "message" : "done";
    cp.after = null;
  }
  const list = [...hits].filter((id) => isId(id, "contact")).slice(0, DEEP_MAX);
  return { done: true, checkpoint: { ...cp, phase: "done", hits: list }, progress: { done: cp.scanned, total: cp.scanned }, result: { contact_ids: list, scanned: cp.scanned } };
}
defineRun("search.deep", { lane: "bulk", step: deepStep, label: "Search notes and messages" });

async function deepSearch(ctx) {
  const q = String((ctx.body && ctx.body.q) || "").trim();
  if (q.length < 3 || q.length > 100) throw new InputError("Search for at least 3 letters.", "q");
  const run = await createRun("search.deep", { q }, ctx.write());
  return { status: 202, data: { run_id: run.id, run: runView(run) } };
}

export const searchRoutes = [
  { method: "GET", path: "/search", auth: "session", perm: "contacts:read_all", subject: "none", mode: "inline", handler: search },
  { method: "POST", path: "/search/deep", auth: "session", perm: "contacts:read_all", subject: "none", mode: "run", handler: deepSearch },
];
