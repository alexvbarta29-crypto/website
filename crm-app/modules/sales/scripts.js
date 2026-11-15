// Settings → Messages → Call scripts (guide-gaps D5, S9b, Rotor's script
// panel): each script has its parts (Opening, Purpose, Discovery questions,
// Value, Next steps, Closing by default), each a title and the words. The
// Power Dialer shows the one picked under the person being called.

import { html, attrs, toast, sheet, cardHead, emptyCard } from "../../core/ui.js";
import { ensureStyles } from "./kit.js";

const blank = () => ({ id: "", name: "New script", sections: [{ key: "opening", title: "Opening", body: "" }, { key: "closing", title: "Closing", body: "" }] });

export default {
  title: "Call scripts",
  async load(params, ctx) {
    ensureStyles();
    const r = await ctx.api("/settings/call_scripts", { cache: false });
    return { cfg: r.data || { scripts: [] }, etag: r.etag };
  },
  render(s) {
    const list = s.cfg.scripts || [];
    return html`<div class="stack dl-scripts">
      ${list.length ? list.map((x, i) => html`<section class="rs-card">${cardHead(x.name, { edit: { label: `Edit ${x.name}`, data: { "sc-edit": String(i) } } })}
        ${(x.sections || []).map((p) => html`<details class="dl-part"><summary>${p.title}</summary><p>${p.body}</p></details>`)}</section>`) : emptyCard({ icon: "doc", title: "No scripts yet" })}
      <div class="btn-row"><button type="button" class="btn primary" data-sc-new>Add a script</button></div>
    </div>`;
  },
  events: {
    "click [data-sc-edit]": (e, el, ctx) => edit(ctx, Number(el.dataset.scEdit)),
    "click [data-sc-new]": (e, el, ctx) => edit(ctx, -1),
  },
};

// One script in a sheet: its name and each part's title and words (one blank part adds a part).
function edit(ctx, i) {
  const s = ctx.state;
  const x = i >= 0 ? s.cfg.scripts[i] : blank();
  const parts = [...(x.sections || []), { key: "", title: "", body: "" }];
  const sh = sheet({
    title: i >= 0 ? `Edit ${x.name}` : "New script",
    body: html`<form class="form" id="sc-f" novalidate><div class="err" data-form-err hidden></div>
      <label class="field"><span>Name</span><input name="name" maxlength="60" required ${attrs({ value: x.name })}></label>
      ${parts.map((p, k) => html`<fieldset class="dl-fs"><label class="field"><span>${p.title ? `Part ${k + 1}` : "Add a part (title)"}</span><input ${attrs({ name: `t${k}`, value: p.title, maxlength: 60 })}></label>
        <label class="field"><span>Words</span><textarea ${attrs({ name: `b${k}`, rows: 3, maxlength: 2000 })}>${p.body}</textarea></label></fieldset>`)}
      <button type="submit" class="btn primary block">Save</button>
      ${i >= 0 && s.cfg.scripts.length > 1 ? html`<button type="button" class="btn danger block" data-sc-del>Delete this script</button>` : ""}</form>`,
    events: {
      "submit #sc-f": (e, form) => {
        e.preventDefault();
        const el = form.elements;
        const sections = parts.map((p, k) => ({ key: p.key || `part${k + 1}`, title: el[`t${k}`].value.trim(), body: el[`b${k}`].value })).filter((p) => p.title);
        const next = { ...x, id: x.id || `s${Date.now().toString(36)}`, name: el.name.value.trim() || "Script", sections };
        const scripts = [...s.cfg.scripts];
        if (i >= 0) scripts[i] = next; else scripts.push(next);
        save(ctx, scripts, sh);
      },
      "click [data-sc-del]": () => save(ctx, s.cfg.scripts.filter((_, k) => k !== i), sh),
    },
  });
}
async function save(ctx, scripts, sh) {
  try { await ctx.api("/settings/call_scripts", { method: "PUT", ifMatch: ctx.state.etag, body: { ...ctx.state.cfg, scripts } }); sh.close(); toast("Saved"); ctx.refresh(); }
  catch (err) { toast(err.status === 412 ? "Someone else changed the scripts. Showing the latest." : err.message || "That didn't save.", { bad: true }); if (err.status === 412) ctx.refresh(); }
}
