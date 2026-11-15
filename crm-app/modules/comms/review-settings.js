// Settings → Messages → Reviews (Flyra's review options, the Rotor guide's
// ST29 and S27; owner defaults Q3 and Q7): the Google review link, the
// in-app star ratings (built, off until the switch), from how many stars
// the Google link shows (1: every rating, as Google's rules want), and the
// customer's review page link to copy for a card or a text by hand.

import { html, attrs, toast, formRow, formRows, toggle, sectionLabel, pillBtn } from "../../core/ui.js";
import { pickContact } from "../../core/pickers.js";
import { loadDoc, saveDoc } from "../system/kit.js";
import { ensureStyles } from "./kit.js";

export default {
  title: "Reviews",
  async load(params, ctx) {
    ensureStyles();
    const doc = await loadDoc(ctx, "reviews");
    return { doc, on: !!doc.data.ratings, link: null };
  },
  render(s) {
    const d = s.doc.data;
    return html`<form class="stack" data-rvs-f novalidate>
      ${sectionLabel("Google")}
      ${formRows([formRow("Review link", html`<input type="url" name="link" autocomplete="off" ${attrs({ value: d.link || "" })}>`, { hint: "Where the review texts send people" })])}
      ${sectionLabel("Star ratings in the app")}
      ${formRows([
        formRow("Ask for stars first", toggle(s.on, { data: { "rvs-on": true }, label: "Ask for stars first" }), { hint: s.on ? "On: the review texts open our star page, then Google" : "Off until the switch: the texts link Google" }),
        formRow("Show the Google link from", html`<select name="link_from_stars">${[1, 2, 3, 4, 5].map((n) => html`<option ${attrs({ value: String(n), selected: (d.link_from_stars || 1) === n })}>${n === 1 ? "Every rating" : `${n} stars up`}</option>`)}</select>`, { hint: "Google's rules don't allow asking only happy customers: keep Every rating" }),
      ])}
      <p class="small muted">A rating of 3 stars or less makes the owners a task to call them back (the guarantee is a free re-clean).</p>
      <button type="submit" class="btn primary block">Save</button>
      ${sectionLabel("A customer's review page")}
      <div class="rs-card stack">
        <p class="small">For a thank-you card's QR code or a text by hand: the star page for one customer.</p>
        ${pillBtn("Make a link", { icon: "link", data: { "rvs-link": true }, wide: true })}
        ${s.link ? html`<div class="cm-url" data-rvs-url>${s.link}</div>` : ""}
      </div>
    </form>`;
  },
  events: {
    "click [data-rvs-on]": (e, el, ctx) => { ctx.state.on = !ctx.state.on; el.setAttribute("aria-checked", String(ctx.state.on)); },
    "click [data-rvs-link]": async (e, el, ctx) => {
      const c = await pickContact(ctx.api, { title: "Whose review page?" });
      if (!c || !c.id) return;
      try { ctx.state.link = (await ctx.api("/ratings/link", { method: "POST", body: { contact_id: c.id } })).data.url; ctx.rerender(); } catch (err) { toast(err.message, { bad: true }); }
    },
    "submit [data-rvs-f]": async (e, form, ctx) => {
      e.preventDefault();
      const s = ctx.state;
      try {
        await saveDoc(ctx, s.doc, { ...s.doc.data, link: form.querySelector("[name=link]").value.trim(), ratings: s.on, link_from_stars: Number(form.querySelector("[name=link_from_stars]").value) });
        toast("Saved");
        ctx.rerender();
      } catch (err) { if (err.status !== 412) toast(err.message, { bad: true }); }
    },
  },
};
