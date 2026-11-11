// The modules' cards on Today and on Home (manifest todayCards:
// { key, perm, order, load, home? }): each loads its own small summary
// (load(ctx) → state) and renders it (render(state, cardCtx) → html``); one
// that fails is left out. A card may also have events
// ({ "click [data-x]": (event, el, cardCtx) => ... }, delegated inside the
// card) and mount(el, state, cardCtx); cardCtx.state is the card's own
// state, and cardCtx.rerender() / refresh() redraw the screen it is on.
// (The tech app's day, M4b: the clock bar and the day switcher live in a card.)

import { html, delegate } from "../../core/ui.js";
import { MANIFESTS } from "../index.js";

// → [{ key, mod, state }] for the cards this person may see (keep: a filter on the manifest entry).
export async function loadCards(ctx, keep = () => true) {
  const defs = MANIFESTS.flatMap((m) => m.todayCards || []).filter((c) => c && keep(c) && typeof c.load === "function" && (!c.perm || ctx.can(c.perm))).sort((a, b) => (a.order || 50) - (b.order || 50));
  const out = await Promise.all(defs.map(async (c) => {
    try { const mod = (await c.load()).default; return { key: c.key, mod, state: mod.load ? await mod.load(ctx) : {} }; } catch (e) { return null; }
  }));
  return out.filter(Boolean);
}

export const cardCtx = (c, ctx) => ({ ...ctx, get state() { return c.state; }, set state(v) { c.state = v; }, rerender: () => ctx.rerender && ctx.rerender(), refresh: () => ctx.refresh() });

// Each card's html`` in its own wrapper ("" for one with nothing to show).
export function drawCards(cards, ctx) {
  return (cards || []).map((c) => {
    let out = "";
    try { out = c.mod.render(c.state, cardCtx(c, ctx)); } catch (e) { out = ""; }
    return String(out || "").trim() === "" ? "" : html`<div class="today-card" style="display:contents" data-card="${c.key || ""}">${out}</div>`;
  });
}

// The cards' own events and mount, inside each card (call after every paint).
export function wireCards(view, cards, ctx) {
  for (const c of cards || []) {
    if (!c.key || !c.mod || !(c.mod.events || c.mod.mount)) continue;
    const el = view.querySelector(`[data-card="${c.key}"]`);
    if (!el || el.dataset.wired) continue;
    el.dataset.wired = "1";
    const cc = cardCtx(c, ctx);
    if (c.mod.events) {
      const wrapped = {};
      for (const [k, fn] of Object.entries(c.mod.events)) wrapped[k] = (e, x) => fn(e, x, cc);
      delegate(el, wrapped);
    }
    if (c.mod.mount) { try { c.mod.mount(el, c.state, cc); } catch (e) { /* a card's mount never breaks the screen */ } }
  }
}
