// Customers (design §9.1, §9.2; guide-gaps §2.5 C1-C7, Rotor's Customers):
// instant search over the contacts index kept on the phone (name, phone,
// email, address, tags: every word must match). One row of tiles IS the
// filter (Customers · Plan members · Owes · Former · Archived · Everyone,
// with counts and the money owed); leads have their own screen, but a search
// finds everyone. On a phone (or beside a contact) each person is a
// two-line row with Rotor's columns' key facts: the name and the lifetime
// value (LV), then town · sale value (SV) · who it's assigned to, with
// "Owes $X" (red: outstanding) or the status (Active) on the right; a round
// call; a long press opens Edit / Archive. On a desk (the list 700 px wide
// or more) it is Rotor's table (the kit's dataTable): Name, Email, Phone,
// City, Status, SV, LV, Outstanding, Assigned to, and a round Edit; "Add
// Customer" is the header's red pill.
// The filter sheet holds the source and the sort (Name, Lifetime value,
// Sale value, Outstanding, Newest). "..." → Select: pick rows, then Tag,
// Owner, Add to a pipeline, Export CSV or Archive (POST /contacts/bulk).
// Sorted by name: letter groups with sticky headings and a letter rail.
// Long lists render 60 rows at once and the rest in chunks, so a thousand
// contacts open at once on an older iPhone. Coming back keeps the search,
// the tile, the sort and the scroll position.

import { html, icon, render, attrs, toast, sheet, tileRow, listRow, dataTable, statusPill, filterSheet, actionSheet, confirmSheet, pillBtn } from "../../core/ui.js";
import { screenButtons } from "../../core/nav.js";
import { pickFrom } from "../../core/pickers.js";
import { ensureStyles, contactsIndex, forgetIndex, lifecyclePill, phoneText, emptyCard, followRun, telHref } from "./kit.js";
import { time as fmtTime, money, initials } from "../../core/format.js";

// The tiles (they ARE the filter): the lifecycle, plan members, who owes money, and everyone but the archived.
export const TILES = [["customer", "Customers"], ["plan", "Plan members"], ["owes", "Owes"], ["former_customer", "Former"], ["archived", "Archived"], ["", "Everyone"]];
export const SORTS = [["name", "Name"], ["lv", "Lifetime value"], ["sv", "Sale value"], ["owed", "Outstanding"], ["new", "Newest"]];
export const FIRST_CHUNK = 60;
export const TABLE_MIN = 700;      // the list this wide or wider: Rotor's table
export const CHUNK = 50;
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

const digits = (s) => String(s || "").replace(/\D/g, "");
const words = (q) => String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
const plans = (r) => (Array.isArray(r.pl) ? r.pl.length : r.pl ? 1 : 0);

// Same rules as the server's list (routes.mjs rowMatches): pure.
export function matches(row, ws) {
  if (!ws.length) return true;
  const text = [row.n, row.co, ...(row.e || []), row.a, row.c, row.z, ...(row.tg || []), row.src].join(" ").toLowerCase();
  const phones = (row.p || []).join(" ");
  return ws.every((w) => text.includes(w) || (digits(w).length >= 3 && digits(w) === w.replace(/[^\d]/g, "") && phones.includes(digits(w))));
}
// chip: a tile key ("" everyone but the archived). A search on the Customers tile finds everyone (leads too).
export function filter(rows, { q = "", chip = "", src = "" } = {}) {
  const ws = words(q);
  const tile = chip === "customer" && ws.length ? "" : chip;
  return rows.filter((r) => {
    if (tile === "plan") { if (!plans(r) || r.lc === "archived") return false; }
    else if (tile === "owes") { if (!(r.mb > 0) || r.lc === "archived") return false; }
    else if (tile) { if (r.lc !== tile) return false; } else if (r.lc === "archived") return false;
    if (src && r.src !== src) return false;
    return matches(r, ws);
  });
}
// The tiles' counts (and the money owed) over the whole index (pure).
export function tileCounts(rows) {
  const out = { customer: 0, plan: 0, owes: 0, owes_cents: 0, former_customer: 0, archived: 0, "": 0 };
  for (const r of rows) {
    if (r.lc === "archived") { out.archived += 1; continue; }
    out[""] += 1;
    if (r.lc === "customer") out.customer += 1;
    if (r.lc === "former_customer") out.former_customer += 1;
    if (plans(r)) out.plan += 1;
    if (r.mb > 0) { out.owes += 1; out.owes_cents += r.mb; }
  }
  return out;
}
const sortKey = (r) => String(r.l || "").replace(/^[^\p{L}\p{N}]+/u, "") || String(r.f || "").replace(/^[^\p{L}\p{N}]+/u, "") || String(r.co || "");
export const letterOf = (r) => { const ch = sortKey(r).charAt(0).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase(); return /^[A-Z]$/.test(ch) ? ch : "#"; };
const byName = (a, b) => {
  const la = letterOf(a), lb = letterOf(b);
  if (la !== lb) return la === "#" ? 1 : lb === "#" ? -1 : la < lb ? -1 : 1;
  return collator.compare(sortKey(a), sortKey(b)) || collator.compare(a.f || "", b.f || "");
};
export function grouped(rows) {
  const groups = [];
  for (const r of [...rows].sort(byName)) {
    const l = letterOf(r);
    if (!groups.length || groups[groups.length - 1].l !== l) groups.push({ l, rows: [] });
    groups[groups.length - 1].rows.push(r);
  }
  return groups;
}
// Any other sort: one group without a heading, the biggest (or newest) first, then by name. sv: contact id → sale value.
export function sorted(rows, sort = "name", sv = new Map()) {
  if (sort === "name" || !SORTS.some(([k]) => k === sort)) return grouped(rows);
  const val = (r) => (sort === "lv" ? r.ml || 0 : sort === "sv" ? sv.get(r.id) || 0 : sort === "owed" ? r.mb || 0 : 0);
  const list = [...rows].sort((a, b) => (sort === "new" ? String(b.ca || "").localeCompare(String(a.ca || "")) : val(b) - val(a)) || byName(a, b));
  return list.length ? [{ l: "", rows: list }] : [];
}

const STATUS = { customer: { label: "Active", tone: "green" }, lead: { label: "Lead", tone: "blue" }, former_customer: { label: "Former", tone: "amber" }, archived: { label: "Archived", tone: "grey" } };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthDay = (d) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}` : "");
const telOf = (r) => { const p = r.p && r.p[0] ? String(r.p[0]).replace(/[^\d+]/g, "") : ""; return p ? (p.length === 10 ? "+1" + p : p) : ""; };

const short = (cents) => money(cents || 0).replace(/\.00$/, "");
// One person (Row2), Rotor's key facts: the name and the lifetime value (LV); town · SV · who it's assigned to;
// "Owes $X" in red (outstanding) or the status; a plan tag; a round call; a long press opens the row's "...".
// s: { money, users, plans, sv, picked }.
export function rowHtml(r, s = {}) {
  const plan = s.plans && s.plans.get(r.id);
  const owes = !!s.money && r.mb > 0;
  const sv = s.money && s.sv ? s.sv.get(r.id) || 0 : 0;
  const sub = [r.c, sv ? "SV " + short(sv) : "", s.users ? (r.o ? s.users.get(r.o) : "Unassigned") : "", r.ls ? "last " + monthDay(r.ls) : ""].filter(Boolean).join(" · ");
  const pill = owes ? { label: "Owes " + short(r.mb), tone: "red" } : STATUS[r.lc] || null;
  if (s.picked) {
    const on = s.picked.has(r.id);
    return html`<li class="rs-lrow ct-pick"><button type="button" ${attrs({ class: "rs-lr-main", "data-pick": r.id, "aria-pressed": on ? "true" : "false" })}><span ${attrs({ class: "ct-box" + (on ? " on" : ""), "aria-hidden": "true" })}>${on ? icon("check") : ""}</span><span class="rs-lr-a"><span class="rs-lr-1"><span class="rs-lr-t">${r.n || "No name"}</span></span><span class="rs-lr-2"><span class="rs-lr-s">${sub}</span></span></span></button></li>`;
  }
  const tel = telOf(r);
  return listRow({
    title: r.n || "No name", amount: s.money && r.ml ? r.ml : null, sub, tag: plan ? plan.nm || "Plan" : null, pill,
    href: "#/contacts/" + encodeURIComponent(r.id),
    action: tel ? { icon: "call", label: `Call ${r.n || ""}`, href: telHref(tel) } : null,
    hold: { "row-more": r.id },
  });
}

// Rotor's table on a desk (the kit's dataTable): Name, Email, Phone, City, Status, SV, LV, Outstanding, Assigned to.
export function tableColumns(withMoney) {
  return [
    { key: "name", label: "Name", kind: "title" },
    { key: "email", label: "Email", kind: "text", width: "minmax(0,1.3fr)" },
    { key: "phone", label: "Phone", kind: "text", width: "minmax(118px,.8fr)" },
    { key: "city", label: "City", kind: "text", width: "minmax(0,.8fr)" },
    { key: "st", label: "Status", kind: "status", width: "minmax(88px,.55fr)" },
    withMoney && { key: "sv", label: "SV", kind: "money", width: "minmax(72px,.5fr)" },
    withMoney && { key: "lv", label: "LV", kind: "money", width: "minmax(72px,.5fr)" },
    withMoney && { key: "owed", label: "Outstanding", kind: "money", width: "minmax(100px,.65fr)" },
    { key: "who", label: "Assigned to", kind: "text", width: "minmax(0,.95fr)" },
  ].filter(Boolean);
}
export function tableRow(r, s = {}) {
  const name = s.names && r.o ? s.names.get(r.o) : "";
  const sv = s.sv ? s.sv.get(r.id) || 0 : 0;
  return {
    cells: {
      name: r.n || "No name", email: (r.e || [])[0] || null, phone: r.p && r.p[0] ? phoneText(r.p[0]) : null, city: r.c || null,
      st: STATUS[r.lc] || null, sv: short(sv), lv: short(r.ml), owed: html`<span class="${r.mb > 0 ? "ct-owed" : ""}">${money(r.mb || 0)}</span>`,
      who: name ? statusPill(name, "white", { icon: "user" }) : html`<span class="ct-unas">Unassigned</span>`,
    },
    href: "#/contacts/" + encodeURIComponent(r.id),
    action: s.write ? { icon: "edit", label: `Edit ${r.n || "this contact"}`, href: "#/contacts/" + encodeURIComponent(r.id) + "/edit" } : null,
    edge: s.money && r.mb > 0 ? "red" : null,
    hold: { "row-more": r.id },
  };
}
const tableHtml = (rows, s) => dataTable({ label: "Customers", columns: tableColumns(!!s.money), rows: rows.map((r) => tableRow(r, s)), empty: "Nobody here" });
const groupHtml = (g, s) => html`<section class="ct-grp" data-l="${g.l}">${g.l ? html`<h3 class="ct-ltr">${g.l}</h3>` : ""}<ul class="rs-card flush rs-list ct-rows">${g.rows.map((r) => rowHtml(r, s))}</ul></section>`;

// The most used sources (for the filter sheet).
function topSources(rows, n = 8) {
  const c = new Map();
  for (const r of rows) if (r.src && r.lc !== "archived") c.set(r.src, (c.get(r.src) || 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1]).slice(0, n).map(([x]) => x);
}

let chunkTimer = null;
let listRO = null;
const later = (fn) => (typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 120 }) : setTimeout(fn, 16));
const rowState = (s) => ({ money: s.money, users: s.users, names: s.names, plans: s.plans, sv: s.sv, picked: s.picked, write: s.write });
// Rotor's table: the list is wide (a desk, nothing open beside it) and nobody is picking rows.
const tableMode = (s) => !!s.wide && !s.picked;

function paintList(view, s, ctx) {
  const box = view.querySelector("#ct-list");
  const rail = view.querySelector("#ct-rail");
  const scroll = view.querySelector("#ct-scroll");
  const count = view.querySelector("#ct-count");
  if (!box) return;
  if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null; }
  const rows = filter(s.ix.rows, s);
  const groups = sorted(rows, s.sort, s.sv);
  const rs = rowState(s);
  s.groups = groups;
  s.shown = rows;
  count.textContent = `${rows.length} ${rows.length === 1 ? "contact" : "contacts"}${s.q ? " match" + (rows.length === 1 ? "es" : "") : ""}`;
  if (!rows.length) {
    render(box, s.ix.rows.length
      ? html`<div class="card empty"><h2>Nobody matches</h2><p>Try fewer words, a phone number or a street, or another tile.</p>${s.q.length >= 3 && ctx.can("contacts:read_all") ? html`<div class="btn-row"><button type="button" class="btn" data-deep>${icon("search")}Search notes and messages</button></div>` : ""}</div>`
      : emptyCard("No contacts yet", "Website leads arrive here once an owner turns on Intake mode, and Rotor's customers arrive with the import. New lead adds one by hand."));
    rail.hidden = true;
    scroll.classList.remove("has-rail");
    return;
  }
  if (tableMode(s)) {
    // one table (no letter headings): the first rows at once, the rest appended to its list in chunks
    const flat = groups.flatMap((g) => g.rows);
    let k = Math.min(FIRST_CHUNK, flat.length);
    render(box, html`<div class="ct-table">${tableHtml(flat.slice(0, k), rs)}</div>`);
    const ul = box.querySelector(".rs-tlist");
    const more = () => {
      const t = document.createElement("template");
      render(t, tableHtml(flat.slice(k, k + CHUNK), rs));
      const got = t.content.querySelector(".rs-tlist");
      if (got && ul) ul.append(...got.children);
      k += CHUNK;
    };
    const step = () => { if (k >= flat.length) { chunkTimer = null; return; } more(); chunkTimer = later(step); };
    s.finish = () => { while (k < flat.length) more(); };
    chunkTimer = later(step);
    rail.hidden = true;
    scroll.classList.remove("has-rail");
    return;
  }
  // the first rows at once, the rest in chunks (a big group is cut into pieces too)
  const pieces = [];
  for (const g of groups) for (let k = 0; k < g.rows.length; k += CHUNK) pieces.push({ l: k ? "" : g.l, rows: g.rows.slice(k, k + CHUNK), cont: k > 0 });
  let i = 0;
  const first = [];
  let n = 0;
  while (i < pieces.length && n < FIRST_CHUNK) { first.push(pieces[i]); n += pieces[i].rows.length; i++; }
  render(box, html`${first.map((g) => groupHtml(g, rs))}`);
  const step = () => {
    if (i >= pieces.length) { chunkTimer = null; return; }
    const t = document.createElement("template");
    render(t, groupHtml(pieces[i], rs));
    box.appendChild(t.content);
    i++;
    chunkTimer = later(step);
  };
  s.finish = () => { while (i < pieces.length) { const t = document.createElement("template"); render(t, groupHtml(pieces[i], rs)); box.appendChild(t.content); i++; } };
  chunkTimer = later(step);
  const showRail = s.sort === "name" && !s.q && rows.length > 40 && groups.length > 3 && !s.picked;
  rail.hidden = !showRail;
  scroll.classList.toggle("has-rail", showRail);
  if (showRail) {
    const live = new Set(groups.map((g) => g.l));
    render(rail, html`${"ABCDEFGHIJKLMNOPQRSTUVWXYZ#".split("").map((l) => html`<span class="${live.has(l) ? "" : "off"}">${l}</span>`)}`);
  }
}

function jumpTo(view, s, clientY) {
  const rail = view.querySelector("#ct-rail");
  const scroll = view.querySelector("#ct-scroll");
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ#";
  const spans = rail.querySelectorAll("span");
  if (!spans.length) return;
  const top = spans[0].getBoundingClientRect().top;
  const bottom = spans[spans.length - 1].getBoundingClientRect().bottom;
  const idx = Math.max(0, Math.min(letters.length - 1, Math.floor(((clientY - top) / Math.max(1, bottom - top)) * letters.length)));
  if (s.finish) s.finish();
  // the nearest letter at or after the one under the finger that has contacts
  for (let k = idx; k < letters.length; k++) {
    const el = view.querySelector(`.ct-grp[data-l="${letters[k]}"]`);
    if (el) { scroll.scrollTop = el.offsetTop - 2; return; }
  }
}

const filtered = (s) => !!s.src || (s.sort && s.sort !== "name");
// The list's own "...": Select (bulk), Export the list shown, Merge review.
function moreGroups(s, ctx) {
  if (!s || !s.ix) return [];
  return [[
    ctx.can("contacts:write") && { label: s.picked ? "Stop selecting" : "Select", icon: "check", run: () => setSelect(ctx, !s.picked), data: { select: true } },
    { label: "Export this list (CSV)", icon: "share", run: () => downloadCsv(csvOf(s.shown || [], { money: s.money }), "customers.csv") },
    ctx.can("contacts:merge") && { label: "Merge review", icon: "copy", hint: s.dupes ? String(s.dupes) : null, href: "#/merge" },
  ]];
}
// The phone's round buttons: search (the field opens in place) and filter (source and sort).
function roundButtons(view, s, ctx) {
  screenButtons([
    { key: "find", icon: "search", label: "Search customers", on: s.find, expanded: s.find },
    { key: "filter", icon: "filter", label: filtered(s) ? "Filter (on)" : "Filter", on: filtered(s) },
    { key: "more", icon: "more", label: "More", badge: s.dupes || 0 },
  ], (key) => {
    if (key === "more") { actionSheet("Customers", moreGroups(s, ctx)); return; }
    if (key === "find") {
      s.find = !s.find || !!s.q;
      ctx.keep.find = s.find;
      const bar = view.querySelector(".ct-bar");
      if (bar) bar.classList.toggle("open", s.find);
      roundButtons(view, s, ctx);
      if (s.find) { const q = view.querySelector("#ct-q"); if (q) q.focus(); }
      return;
    }
    if (key === "filter") openFilter(view, s, ctx);
  });
}
function repaint(view, s, ctx) {
  ctx.keep.chip = s.chip;
  ctx.keep.src = s.src;
  ctx.keep.sort = s.sort;
  ctx.keep.scroll = 0;
  view.querySelectorAll("[data-tile=ct]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.key === s.chip)));
  paintList(view, s, ctx);
  const sc = view.querySelector("#ct-scroll");
  if (sc) sc.scrollTop = 0;
  roundButtons(view, s, ctx);
}
async function openFilter(view, s, ctx) {
  const groups = [
    s.sources.length && { key: "src", label: "Source", type: "radio", options: s.sources.map((x) => [x, x]) },
    { key: "sort", label: "Sort", type: "sort", default: "name", options: s.money ? SORTS : SORTS.filter(([k]) => k === "name" || k === "new") },
  ].filter(Boolean);
  const v = await filterSheet({ title: "Filter", values: { src: s.src || null, sort: s.sort || "name" }, groups, count: (x) => filter(s.ix.rows, { ...s, src: x.src || "" }).length });
  if (!v) return;
  s.src = v.src || "";
  s.sort = v.sort || "name";
  repaint(view, s, ctx);
}

// ------------------------------------------------------------ Select (bulk)

function bulkBar(s) {
  const n = s.picked ? s.picked.size : 0;
  return html`<div class="ct-bulk" role="toolbar" aria-label="With the people picked"><span class="ct-bulk-n" aria-live="polite">${n} picked</span>
    <div class="ct-bulk-acts">${pillBtn("Tag", { icon: "flag", data: { bulk: "tag" }, disabled: !n })}${pillBtn("Owner", { icon: "user", data: { bulk: "owner" }, disabled: !n })}${pillBtn("Pipeline", { icon: "pipeline", data: { bulk: "enroll" }, disabled: !n })}${pillBtn("Export", { icon: "share", data: { bulk: "csv" }, disabled: !n })}${pillBtn("Archive", { icon: "archive", data: { bulk: "archive" }, disabled: !n })}${pillBtn("Done", { tone: "solid", data: { bulk: "done" } })}</div></div>`;
}
function setSelect(ctx, on) {
  const s = ctx.state;
  s.picked = on ? new Set() : null;
  ctx.rerender();
}
async function bulkRun(ctx, action, value, ok) {
  const ids = [...ctx.state.picked];
  try {
    const r = await ctx.api("/contacts/bulk", { method: "POST", body: { ids, action, value } });
    const d = r.data || {};
    forgetIndex();
    toast(`${ok}: ${d.done || 0}${d.failed && d.failed.length ? ` (${d.failed.length} didn't change)` : ""}`, { bad: !!(d.failed && d.failed.length) });
    ctx.state.picked = null;
    ctx.refresh();
  } catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
}
// A CSV of the picked rows (name, phones, emails, town, status, owed, lifetime), downloaded on the phone.
export function csvOf(rows, { money: withMoney = false } = {}) {
  const q = (v) => { const x = String(v ?? ""); return /[",\n\r]/.test(x) || /^[=+\-@]/.test(x) ? `"${(/^[=+\-@]/.test(x) ? "'" : "") + x.replace(/"/g, '""')}"` : x; };
  const head = ["Name", "Phone", "Email", "Town", "Status", "Source", ...(withMoney ? ["Owed", "Lifetime"] : [])];
  const lines = rows.map((r) => [r.n, (r.p || []).join(" "), (r.e || []).join(" "), r.c, (STATUS[r.lc] || {}).label || r.lc, r.src, ...(withMoney ? [((r.mb || 0) / 100).toFixed(2), ((r.ml || 0) / 100).toFixed(2)] : [])].map(q).join(","));
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}
function downloadCsv(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function bulkAction(ctx, what) {
  const s = ctx.state;
  if (what === "done") { setSelect(ctx, false); return; }
  if (!s.picked || !s.picked.size) return;
  if (what === "csv") { downloadCsv(csvOf(s.ix.rows.filter((r) => s.picked.has(r.id)), { money: s.money }), "customers.csv"); toast("Downloaded"); return; }
  if (what === "tag") {
    const known = [...new Set(s.ix.rows.flatMap((r) => r.tg || []))].slice(0, 30);
    const sh = sheet({
      title: "Add a tag",
      body: html`<form class="form" id="ct-tag-f" novalidate><label class="field"><span>Tag</span><input name="tag" maxlength="40" required list="ct-tags" autocomplete="off"></label><datalist id="ct-tags">${known.map((t) => html`<option ${attrs({ value: t })}></option>`)}</datalist><button type="submit" class="btn primary block">Tag ${String(s.picked.size)}</button></form>`,
      events: { "submit #ct-tag-f": (e, form) => { e.preventDefault(); const v = form.tag.value.trim(); if (!v) return; sh.close(); bulkRun(ctx, "tag", v, "Tagged"); } },
    });
    return;
  }
  if (what === "owner") {
    let users = [];
    try { users = ((await ctx.api("/users")).data || []).filter((u) => u.status === "active"); } catch (e) { toast(e.message || "The team didn't load.", { bad: true }); return; }
    const v = await pickFrom({ title: "Owner", items: [...users.map((u) => ({ value: u.id, label: u.name })), { value: "", label: "Unassigned" }] });
    if (v !== null) bulkRun(ctx, "owner", v, "Owner saved");
    return;
  }
  if (what === "enroll") {
    let cads = [];
    try { cads = ((await ctx.api("/cadences")).data || []).filter((c) => c.active); } catch (e) { toast(e.message || "The pipelines didn't load.", { bad: true }); return; }
    const key = await pickFrom({ title: "Add to a pipeline", items: cads.map((c) => ({ value: c.key, label: c.name })) });
    if (!key) return;
    const ids = [...s.picked].slice(0, 50);
    let n = 0;
    for (const id of ids) { try { await ctx.api("/enrollments", { method: "POST", body: { contact_id: id, cadence_key: key } }); n += 1; } catch (e) { /* one that can't join doesn't stop the rest */ } }
    toast(`Added ${n} of ${ids.length}`, { bad: n < ids.length });
    s.picked = null;
    ctx.refresh();
    return;
  }
  if (what === "archive") {
    const yes = await confirmSheet(`Archive ${s.picked.size} ${s.picked.size === 1 ? "contact" : "contacts"}? They leave the lists but keep their history, and their portal links stop working. You can restore each one.`, { title: "Archive", yes: "Archive", danger: true });
    if (yes) bulkRun(ctx, "archive", "other", "Archived");
  }
}

// A row's long press: Edit, Call, Archive.
function rowMore(ctx, id) {
  const r = ctx.state.ix.rows.find((x) => x.id === id);
  if (!r) return;
  const tel = telOf(r);
  actionSheet(r.n || "Contact", [
    [ctx.can("contacts:write") && { label: "Edit", icon: "edit", href: "#/contacts/" + encodeURIComponent(id) + "/edit" },
      tel && { label: `Call ${phoneText(r.p[0])}`, icon: "call", href: telHref(tel) },
      tel && { label: "Text", icon: "chat", href: "sms:" + tel }],
    [ctx.can("contacts:write") && r.lc !== "archived" && { label: "Archive", icon: "archive", danger: true, run: async () => {
      if (!(await confirmSheet(`Archive ${r.n || "this contact"}? You can restore them from Archived.`, { title: "Archive", yes: "Archive", danger: true }))) return;
      try { await ctx.api(`/contacts/${encodeURIComponent(id)}/archive`, { method: "POST", body: { reason: "other" } }); forgetIndex(); toast("Archived"); ctx.refresh(); } catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
    } }],
  ]);
}

export default {
  title: "Customers",
  flush: true,
  async load(params, ctx) {
    ensureStyles();
    const ix = await contactsIndex(ctx);
    const [dupes, planRows, users] = await Promise.all([
      ctx.can("contacts:merge") ? ctx.api("/merge-candidates?status=pending", { cache: false }).then((m) => (m.meta && m.meta.total) || 0).catch(() => 0) : 0,
      // the plans (their names and sale values) for the rows: one read of the plans list, when this person may see plans
      ctx.can("plans:read") ? ctx.api("/plans").then((p) => p.data || []).catch(() => []) : [],
      ctx.can("schedule:read") ? ctx.api("/users").then((u) => u.data || []).catch(() => []) : [],
    ]);
    const plansOf = new Map();
    const sv = new Map();
    for (const x of planRows) {
      if (!x.c || !["active", "cancelling", "paused", "pending"].includes(x.st)) continue;
      if (!plansOf.has(x.c)) plansOf.set(x.c, x);
      sv.set(x.c, (sv.get(x.c) || 0) + (Number.isSafeInteger(x.sv) ? x.sv : 0));
    }
    return {
      ix, dupes, plans: plansOf, sv, users: new Map(users.map((u) => [u.id, initials(u.name)])), names: new Map(users.map((u) => [u.id, u.name])), money: ctx.can("invoices:read_all"),
      write: ctx.can("contacts:write"), wide: false,
      q: ctx.keep.q || "", chip: ctx.keep.chip === undefined ? "customer" : ctx.keep.chip, src: ctx.keep.src || "", sort: ctx.keep.sort || "name",
      sources: topSources(ix.rows), find: !!ctx.keep.find || !!ctx.keep.q, picked: null,
    };
  },
  render(s, ctx) {
    const n = tileCounts(s.ix.rows);
    const tiles = TILES.filter(([k]) => k !== "owes" || s.money).map(([key, label]) => ({ key, label, value: n[key], ...(key === "owes" ? { money: n.owes_cents, tone: n.owes ? "red" : null } : {}) }));
    return html`<div class="ct-screen">
      <div class="${"ct-bar" + (s.find ? " open" : "")}">
        <label class="ct-search">${icon("search")}<span class="sr">Search contacts</span><input id="ct-q" type="search" ${attrs({ value: s.q, placeholder: "Name, phone, email or street", autocomplete: "off", autocapitalize: "none", spellcheck: "false", enterkeyhint: "search" })}><button type="button" class="clear" data-clear aria-label="Clear the search" ${attrs({ hidden: !s.q })}>✕</button></label>
        <p class="ct-count" id="ct-count" aria-live="polite"></p>
      </div>
      <div class="ct-tiles">${tileRow(tiles, { name: "ct", on: s.chip, label: "Show" })}</div>
      <div class="ct-body">
        <div class="${"ct-scroll" + (s.picked ? " picking" : "")}" id="ct-scroll">
          ${s.ix.offline ? html`<div class="note" style="margin-bottom:10px">Offline: the list as of ${fmtTime(s.ix.as_of || s.ix.at)}.</div>` : ""}
          ${s.dupes && !s.picked ? html`<a class="notice" href="#/merge">${icon("contacts")}<span>${s.dupes} possible ${s.dupes === 1 ? "duplicate" : "duplicates"} to review</span><span class="chev" aria-hidden="true"></span></a>` : ""}
          <div id="ct-list"></div>
          <div id="ct-deep"></div>
        </div>
        <div class="ct-rail" id="ct-rail" aria-hidden="true" hidden></div>
      </div>
      ${s.picked ? bulkBar(s) : ""}
    </div>`;
  },
  // the list's own "..." (a desk's header; a phone has it as a round button, roundButtons)
  more: (s, ctx) => moreGroups(s, ctx),
  // Rotor's "+ Add Customer" (a desk's header; a phone has the + of the tab bar)
  action: (s, ctx) => (ctx.can("contacts:write") && typeof matchMedia === "function" && matchMedia("(min-width: 1000px)").matches ? { label: "Add Customer", run: () => ctx.go("/contacts/new?as=customer") } : null),
  mount(view, s, ctx) {
    const list = view.querySelector("#ct-list");
    s.wide = !!list && list.clientWidth >= TABLE_MIN;
    paintList(view, s, ctx);
    // the table on a wide list, two-line rows when it narrows (a contact opened beside it, a smaller window)
    if (list && typeof ResizeObserver === "function") {
      if (listRO) listRO.disconnect();
      listRO = new ResizeObserver(() => {
        const wide = list.clientWidth >= TABLE_MIN;
        if (!list.isConnected || wide === s.wide || !list.clientWidth) return;
        s.wide = wide;
        paintList(view, s, ctx);
      });
      listRO.observe(list);
    }
    roundButtons(view, s, ctx);
    const scroll = view.querySelector("#ct-scroll");
    if (ctx.keep.scroll) { if (s.finish) s.finish(); scroll.scrollTop = ctx.keep.scroll; }
    scroll.addEventListener("scroll", () => { ctx.keep.scroll = scroll.scrollTop; }, { passive: true });
    const rail = view.querySelector("#ct-rail");
    let dragging = false;
    rail.addEventListener("pointerdown", (e) => { dragging = true; rail.classList.add("live"); try { rail.setPointerCapture(e.pointerId); } catch (x) { /* old Safari */ } jumpTo(view, s, e.clientY); });
    rail.addEventListener("pointermove", (e) => { if (dragging) jumpTo(view, s, e.clientY); });
    const stop = () => { dragging = false; rail.classList.remove("live"); };
    rail.addEventListener("pointerup", stop);
    rail.addEventListener("pointercancel", stop);
  },
  unmount() { if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null; } if (listRO) { listRO.disconnect(); listRO = null; } },
  events: {
    "input #ct-q": (e, el, ctx) => {
      const s = ctx.state;
      s.q = el.value;
      ctx.keep.q = s.q;
      ctx.keep.scroll = 0;
      clearTimeout(s.timer);
      s.timer = setTimeout(() => {
        const view = document.getElementById("view");
        paintList(view, s, ctx);
        view.querySelector("#ct-scroll").scrollTop = 0;
        const clear = view.querySelector("[data-clear]");
        if (clear) clear.hidden = !s.q;
      }, 120);
    },
    "click [data-clear]": (e, el, ctx) => {
      const view = document.getElementById("view");
      const input = view.querySelector("#ct-q");
      input.value = "";
      ctx.state.q = "";
      ctx.keep.q = "";
      el.hidden = true;
      paintList(view, ctx.state, ctx);
      input.focus();
    },
    "click [data-tile=ct]": (e, el, ctx) => {
      const s = ctx.state;
      s.chip = el.dataset.key === s.chip && el.dataset.key !== "customer" ? "customer" : el.dataset.key;
      repaint(document.getElementById("view"), s, ctx);
    },
    "click [data-pick]": (e, el, ctx) => {
      const p = ctx.state.picked;
      if (!p) return;
      const id = el.dataset.pick;
      if (p.has(id)) p.delete(id); else p.add(id);
      el.setAttribute("aria-pressed", p.has(id) ? "true" : "false");
      const box = el.querySelector(".ct-box");
      if (box) { box.classList.toggle("on", p.has(id)); render(box, p.has(id) ? icon("check") : html``); }
      const bar = document.querySelector(".ct-bulk");
      if (bar) { const t = document.createElement("template"); render(t, bulkBar(ctx.state)); bar.replaceWith(t.content); }
    },
    "click [data-bulk]": (e, el, ctx) => bulkAction(ctx, el.dataset.bulk),
    "rs-hold [data-row-more]": (e, el, ctx) => rowMore(ctx, el.dataset.rowMore),
    "click [data-deep]": async (e, el, ctx) => {
      const s = ctx.state;
      el.disabled = true;
      el.textContent = "Searching…";
      try {
        const r = await ctx.api("/search/deep", { method: "POST", body: { q: s.q } });
        const run = await followRun(ctx, r.data.run_id);
        const hits = new Set((run && run.result && run.result.contact_ids) || []);
        const rows = s.ix.rows.filter((x) => hits.has(x.id));
        const box = document.getElementById("ct-deep");
        render(box, html`<div class="section-h">In notes and messages</div>${rows.length ? html`<ul class="rs-card flush rs-list">${rows.map((x) => rowHtml(x, rowState(s)))}</ul>` : html`<p class="muted small">Nothing there either.</p>`}`);
        if (!run) toast("Still searching. Try again in a minute.");
      } catch (err) {
        toast(err.message || "That search didn't run.", { bad: true });
      }
      el.remove();
    },
  },
};

export { lifecyclePill };
