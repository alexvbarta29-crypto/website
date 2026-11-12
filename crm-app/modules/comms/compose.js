// "Text someone" (design §9.1 Create button): pick a contact, then their
// thread opens with the composer.

import { html, icon } from "../../core/ui.js";
import { pickContact } from "../../core/pickers.js";
import { ensureStyles } from "./kit.js";

async function pick(ctx) {
  const c = await pickContact(ctx.api, { title: "Text someone" });
  if (c && c.id) ctx.go("/inbox/" + encodeURIComponent(c.id), { replace: true });
}

export default {
  async load() { ensureStyles(); return {}; },
  render: () => html`<div class="stack"><div class="card empty"><div class="art">${icon("text")}</div><h2>Who is it for?</h2><p>Pick a contact and their conversation opens.</p><div class="btn-row"><button type="button" class="btn primary" data-pick>Pick a contact</button></div></div></div>`,
  events: { "click [data-pick]": (e, el, ctx) => pick(ctx) },
};
