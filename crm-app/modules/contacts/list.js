// Contacts (design §9.1, §9.2 "Contacts"): instant search over the
// contacts index kept on the phone (name, phone, email, address, tags:
// every word must match), chips (All · Leads · Customers · Plan members ·
// Former · Archived, and the common sources), letter groups with sticky
// headings and a letter rail. Long lists render 60 rows at once and the
// rest in chunks, so a thousand contacts open at once on an older iPhone.
// Coming back keeps the search, the chips and the scroll position.
// On a phone (the Nov 2026 look, Rotor's Customers): only the large title
// and round buttons on top (search, filter, archived, the coral +); the
// search field opens in place, the chips, the count and "possible
// duplicates" are in the filter sheet, and the cards run without letter
// headings or a letter rail. A desk keeps them all on screen.

import { html, icon, render, attrs, toast, sheet } from "../../core/ui.js";
import { screenButtons } from "../../core/nav.js";
import { ensureStyles, contactsIndex, lifecyclePill, phoneText, emptyCard, followRun } from "./kit.js";
import { time as fmtTime } from "../../core/format.js";

const CHIPS = [["", "All"], ["lead", "Leads"], ["customer", "Customers"], ["plan", "Plan members"], ["former_customer", "Former"], ["archived", "Archived"]];
export const FIRST_CHUNK = 60;
export const CHUNK = 50;
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

const digits = (s) => String(s || "").replace(/\D/g, "");
const words = (q) => String(q || "").toLowerCase().split(/\s+/).filter(Boolean);

// Same rules as the server's list (routes.mjs rowMatches): pure.
export function matches(row, ws) {
  if (!ws.length) return true;
  const text = [row.n, row.co, ...(row.e || []), row.a, row.c, row.z, ...(row.tg || []), row.src].join(" ").toLowerCase();
  const phones = (row.p || []).join(" ");
  return ws.every((w) => text.includes(w) || (digits(w).length >= 3 && digits(w) === w.replace(/[^\d]/g, "") && phones.includes(digits(w))));
}
export function filter(rows, { q = "", chip = "", src = "" } = {}) {
  const ws = words(q);
  return rows.filter((r) => {
    if (chip === "plan") { if (!(Array.isArray(r.pl) ? r.pl.length : r.pl)) return false; } else if (chip) { if (r.lc !== chip) return false; } else if (r.lc === "archived") return false;
    if (src && r.src !== src) return false;
    return matches(r, ws);
  });
}
const sortKey = (r) => String(r.l || "").replace(/^[^\p{L}\p{N}]+/u, "") || String(r.f || "").replace(/^[^\p{L}\p{N}]+/u, "") || String(r.co || "");
export const letterOf = (r) => { const ch = sortKey(r).charAt(0).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase(); return /^[A-Z]$/.test(ch) ? ch : "#"; };
export function grouped(rows) {
  const sorted = [...rows].sort((a, b) => {
    const la = letterOf(a), lb = letterOf(b);
    if (la !== lb) return la === "#" ? 1 : lb === "#" ? -1 : la < lb ? -1 : 1;
    return collator.compare(sortKey(a), sortKey(b)) || collator.compare(a.f || "", b.f || "");
  });
  const groups = [];
  for (const r of sorted) {
    const l = letterOf(r);
    if (!groups.length || groups[groups.length - 1].l !== l) groups.push({ l, rows: [] });
    groups[groups.length - 1].rows.push(r);
  }
  return groups;
}

const rowHtml = (r) => html`<li><a class="row" href="${"#/contacts/" + encodeURIComponent(r.id)}">
  <span class="who"><span class="nm">${r.n || "No name"}</span><span class="sub">${[r.p && r.p[0] ? phoneText(r.p[0]) : (r.e && r.e[0]) || "", r.c].filter(Boolean).join(" · ") || "No phone or email"}</span></span>
  <span class="end">${r.lc === "customer" ? "" : lifecyclePill(r.lc)}<span class="chev" aria-hidden="true"></span></span>
</a></li>`;

// A customer as a card (the Nov 2026 layout, after Rotor's Customers): the
// name, a status pill (Active, Lead, ...), the plan or service, a lower band
// with FREQUENCY (the plan's, "One-time" for a customer without one) and
// SINCE (customer since, or added), and round call and text buttons.
const STATUS = { customer: ["Active", "green"], lead: ["Lead", "blue"], former_customer: ["Former", "amber"], archived: ["Archived", ""] };
const FREQ = { quarterly: "Quarterly", biannual: "Biannual", monthly: "Monthly", lights_annual: "Annual", custom: "Custom" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const since = (d) => (typeof d === "string" && /^\d{4}-\d{2}/.test(d) ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4) === String(new Date().getFullYear()) ? Number(d.slice(8, 10)) || "" : d.slice(0, 4)}`.trim() : "-");
export function cardHtml(r, plans = new Map()) {
  const [st, tone] = STATUS[r.lc] || [r.lc || "Lead", ""];
  const plan = plans.get(r.id);
  const service = plan ? plan.nm : (r.tg || []).find((t) => /light|window|gutter|wash/i.test(t)) || "";
  const phone = r.p && r.p[0] ? String(r.p[0]).replace(/[^\d+]/g, "") : "";
  const freq = plan ? FREQ[plan.ck] || "Plan" : r.lc === "customer" ? "One-time" : "-";
  return html`<li class="cc"><a class="cc-top" href="${"#/contacts/" + encodeURIComponent(r.id)}">
    <span class="cc-nm">${r.n || "No name"}</span><span class="cc-pills"><span ${attrs({ class: "cc-st " + tone })}>${st}</span>${service ? html`<span class="cc-svc">${service}</span>` : ""}</span></a>
    <div class="cc-band"><span class="cc-k"><small>Frequency</small><b>${freq}</b></span><span class="cc-k"><small>Since</small><b>${since(r.cs)}</b></span>
      <span class="cc-acts">${phone ? html`<a class="rnd" ${attrs({ href: "tel:" + (phone.length === 10 ? "+1" + phone : phone), "aria-label": `Call ${r.n || ""}` })}>${icon("call")}</a><a class="rnd" ${attrs({ href: "sms:" + (phone.length === 10 ? "+1" + phone : phone), "aria-label": `Text ${r.n || ""}` })}>${icon("chat")}</a>` : ""}</span></div></li>`;
}
let plansOf = new Map();
const groupHtml = (g) => html`<section class="ct-grp" data-l="${g.l}"><h3 class="ct-ltr">${g.l}</h3><ul class="cc-list">${g.rows.map((r) => cardHtml(r, plansOf))}</ul></section>`;

// The most used sources (chips after the lifecycle ones).
function topSources(rows, n = 5) {
  const c = new Map();
  for (const r of rows) if (r.src && r.lc !== "archived") c.set(r.src, (c.get(r.src) || 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1]).slice(0, n).map(([s]) => s);
}

let chunkTimer = null;
const later = (fn) => (typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 120 }) : setTimeout(fn, 16));

function paintList(view, s, ctx) {
  const box = view.querySelector("#ct-list");
  const rail = view.querySelector("#ct-rail");
  const scroll = view.querySelector("#ct-scroll");
  const count = view.querySelector("#ct-count");
  if (!box) return;
  if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null; }
  const rows = filter(s.ix.rows, s);
  const groups = grouped(rows);
  s.groups = groups;
  count.textContent = `${rows.length} ${rows.length === 1 ? "contact" : "contacts"}${s.q ? " match" + (rows.length === 1 ? "es" : "") : ""}`;
  if (!rows.length) {
    render(box, s.ix.rows.length
      ? html`<div class="card empty"><h2>Nobody matches</h2><p>Try fewer words, a phone number or a street.</p>${s.q.length >= 3 && ctx.can("contacts:read_all") ? html`<div class="btn-row"><button type="button" class="btn" data-deep>${icon("search")}Search notes and messages</button></div>` : ""}</div>`
      : emptyCard("No contacts yet", "Website leads arrive here once an owner turns on Intake mode, and Rotor's customers arrive with the import. New lead adds one by hand."));
    rail.hidden = true;
    scroll.classList.remove("has-rail");
    return;
  }
  // the first rows at once, the rest in chunks
  let i = 0;
  const first = [];
  let n = 0;
  while (i < groups.length && n < FIRST_CHUNK) { first.push(groups[i]); n += groups[i].rows.length; i++; }
  render(box, html`${first.map(groupHtml)}`);
  const step = () => {
    if (i >= groups.length) { chunkTimer = null; return; }
    const part = [];
    let m = 0;
    while (i < groups.length && m < CHUNK) { part.push(groups[i]); m += groups[i].rows.length; i++; }
    const t = document.createElement("template");
    render(t, html`${part.map(groupHtml)}`);
    box.appendChild(t.content);
    chunkTimer = later(step);
  };
  s.finish = () => { while (i < groups.length) { const t = document.createElement("template"); render(t, groupHtml(groups[i])); box.appendChild(t.content); i++; } };
  chunkTimer = later(step);
  const showRail = !s.q && rows.length > 40 && groups.length > 3;
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
  const r = rail.getBoundingClientRect();
  const spans = rail.querySelectorAll("span");
  if (!spans.length) return;
  const top = spans[0].getBoundingClientRect().top;
  const bottom = spans[spans.length - 1].getBoundingClientRect().bottom;
  const idx = Math.max(0, Math.min(letters.length - 1, Math.floor(((clientY - top) / Math.max(1, bottom - top)) * letters.length)));
  void r;
  if (s.finish) s.finish();
  // the nearest letter at or after the one under the finger that has contacts
  for (let k = idx; k < letters.length; k++) {
    const el = view.querySelector(`.ct-grp[data-l="${letters[k]}"]`);
    if (el) { scroll.scrollTop = el.offsetTop - 2; return; }
  }
}

// The phone's round buttons: search (the field opens in place), filter (a
// sheet: the chips, the sources, the count, duplicates to review), archived.
function roundButtons(view, s, ctx) {
  const filtered = !!(s.chip && s.chip !== "archived") || !!s.src;
  screenButtons([
    { key: "find", icon: "search", label: "Search customers", on: s.find, expanded: s.find },
    { key: "filter", icon: "filter", label: filtered ? "Filter (on)" : "Filter", on: filtered, badge: s.dupes || 0 },
    { key: "archived", icon: "archive", label: "Archived", on: s.chip === "archived", pressed: s.chip === "archived" },
  ], (key) => {
    if (key === "find") {
      s.find = !s.find || !!s.q;
      ctx.keep.find = s.find;
      const bar = view.querySelector(".ct-bar");
      if (bar) bar.classList.toggle("open", s.find);
      roundButtons(view, s, ctx);
      if (s.find) { const q = view.querySelector("#ct-q"); if (q) q.focus(); }
      return;
    }
    if (key === "archived") { pick(view, s, ctx, { chip: s.chip === "archived" ? "" : "archived" }); return; }
    if (key === "filter") filterSheet(view, s, ctx);
  });
}
function pick(view, s, ctx, { chip = s.chip, src = s.src } = {}) {
  s.chip = chip;
  s.src = src;
  ctx.keep.chip = chip;
  ctx.keep.src = src;
  ctx.keep.scroll = 0;
  view.querySelectorAll("[data-chip]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.chip === s.chip)));
  view.querySelectorAll("[data-src]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.src === s.src)));
  paintList(view, s, ctx);
  const sc = view.querySelector("#ct-scroll");
  if (sc) sc.scrollTop = 0;
  roundButtons(view, s, ctx);
}
function filterSheet(view, s, ctx) {
  const n = filter(s.ix.rows, s).length;
  const sh = sheet({
    title: "Show",
    body: html`<div class="ct-filter">
      <div class="chips wrap" role="group" aria-label="Show">${CHIPS.map(([v, label]) => html`<button type="button" class="chip" ${attrs({ "data-f-chip": v, "aria-pressed": String(s.chip === v) })}>${label}</button>`)}</div>
      ${s.sources.length ? html`<h3 class="ms-h">Source</h3><div class="chips wrap" role="group" aria-label="Source">${s.sources.map((src) => html`<button type="button" class="chip" ${attrs({ "data-f-src": src, "aria-pressed": String(s.src === src) })}>${src}</button>`)}</div>` : ""}
      <p class="muted small">${n} ${n === 1 ? "contact" : "contacts"}</p>
      ${s.dupes ? html`<a class="notice" href="#/merge" data-f-go>${icon("contacts")}<span>${s.dupes} possible ${s.dupes === 1 ? "duplicate" : "duplicates"} to review</span><span class="chev" aria-hidden="true"></span></a>` : ""}
    </div>`,
    events: {
      "click [data-f-chip]": (e, b) => { pick(view, s, ctx, { chip: b.dataset.fChip === s.chip && b.dataset.fChip ? "" : b.dataset.fChip }); sh.close(); },
      "click [data-f-src]": (e, b) => { pick(view, s, ctx, { src: s.src === b.dataset.fSrc ? "" : b.dataset.fSrc }); sh.close(); },
      "click [data-f-go]": () => sh.close(),
    },
  });
}

export default {
  title: "Customers",
  flush: true,
  async load(params, ctx) {
    ensureStyles();
    const ix = await contactsIndex(ctx);
    let dupes = 0;
    if (ctx.can("contacts:merge")) {
      try { const m = await ctx.api("/merge-candidates?status=pending", { cache: false }); dupes = (m.meta && m.meta.total) || 0; } catch (e) { dupes = 0; }
    }
    // the plans (their names and how often) for the cards: one read of the plans list, when this person may see plans
    if (ctx.can("plans:read")) {
      try {
        const p = await ctx.api("/plans");
        plansOf = new Map();
        for (const x of p.data || []) if (x.c && !plansOf.has(x.c) && ["active", "cancelling", "paused", "pending"].includes(x.st)) plansOf.set(x.c, x);
      } catch (e) { /* the cards say what they know */ }
    }
    return { ix, dupes, q: ctx.keep.q || "", chip: ctx.keep.chip || "", src: ctx.keep.src || "", sources: topSources(ix.rows), find: !!ctx.keep.find || !!ctx.keep.q };
  },
  render(s, ctx) {
    return html`<div class="ct-screen">
      <div class="${"ct-bar" + (s.find ? " open" : "")}">
        <label class="ct-search">${icon("search")}<span class="sr">Search contacts</span><input id="ct-q" type="search" ${attrs({ value: s.q, placeholder: "Name, phone, email or street", autocomplete: "off", autocapitalize: "none", spellcheck: "false", enterkeyhint: "search" })}><button type="button" class="clear" data-clear aria-label="Clear the search" ${attrs({ hidden: !s.q })}>✕</button></label>
        <div class="chips" role="group" aria-label="Show">
          ${CHIPS.map(([v, label]) => html`<button type="button" class="chip" ${attrs({ "data-chip": v, "aria-pressed": String(s.chip === v) })}>${label}</button>`)}
          ${s.sources.map((src) => html`<button type="button" class="chip" ${attrs({ "data-src": src, "aria-pressed": String(s.src === src) })}>${src}</button>`)}
        </div>
        <p class="ct-count" id="ct-count" aria-live="polite"></p>
      </div>
      <div class="ct-body">
        <div class="ct-scroll" id="ct-scroll">
          ${s.ix.offline ? html`<div class="note" style="margin-bottom:10px">Offline: the list as of ${fmtTime(s.ix.as_of || s.ix.at)}.</div>` : ""}
          ${s.dupes ? html`<a class="notice" href="#/merge">${icon("contacts")}<span>${s.dupes} possible ${s.dupes === 1 ? "duplicate" : "duplicates"} to review</span><span class="chev" aria-hidden="true"></span></a>` : ""}
          <div id="ct-list"></div>
          <div id="ct-deep"></div>
        </div>
        <div class="ct-rail" id="ct-rail" aria-hidden="true" hidden></div>
      </div>
    </div>`;
  },
  mount(view, s, ctx) {
    paintList(view, s, ctx);
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
  unmount() { if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null; } },
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
    "click [data-chip]": (e, el, ctx) => {
      const s = ctx.state;
      s.chip = el.dataset.chip === s.chip && el.dataset.chip ? "" : el.dataset.chip;
      ctx.keep.chip = s.chip;
      ctx.keep.scroll = 0;
      const view = document.getElementById("view");
      view.querySelectorAll("[data-chip]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.chip === s.chip)));
      paintList(view, s, ctx);
      view.querySelector("#ct-scroll").scrollTop = 0;
    },
    "click [data-src]": (e, el, ctx) => {
      const s = ctx.state;
      s.src = s.src === el.dataset.src ? "" : el.dataset.src;
      ctx.keep.src = s.src;
      const view = document.getElementById("view");
      view.querySelectorAll("[data-src]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.src === s.src)));
      paintList(view, s, ctx);
      view.querySelector("#ct-scroll").scrollTop = 0;
    },
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
        render(box, html`<div class="section-h">In notes and messages</div>${rows.length ? html`<ul class="list">${rows.map(rowHtml)}</ul>` : html`<p class="muted small">Nothing there either.</p>`}`);
        if (!run) toast("Still searching. Try again in a minute.");
      } catch (err) {
        toast(err.message || "That search didn't run.", { bad: true });
      }
      el.remove();
    },
  },
};
