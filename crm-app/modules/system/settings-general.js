// Settings → Company, Hours & holidays, Service area (design §9.2, §4.12:
// settings:general, owners and the office). Each saves its whole document
// with If-Match; someone else's save in between shows the latest instead.

import { html, attrs, toast, icon } from "../../core/ui.js";
import { field, readForm, clearErrors, showError, busy, checkbox } from "../../core/forms.js";
import { dateShort } from "../../core/format.js";
import { loadDoc, saveDoc } from "./kit.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const sectionOf = (path) => (path.endsWith("/hours") ? "hours" : path.endsWith("/service-area") ? "area" : "company");
const list = (s) => String(s || "").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

function company(s) {
  const c = s.company.data;
  return html`<form class="card form" id="f" novalidate>
    <div class="err" data-form-err hidden></div>
    ${field({ label: "Business name", name: "name", value: c.name, autocomplete: "organization" })}
    ${field({ label: "Legal name (on agreements and receipts)", name: "legal_name", value: c.legal_name })}
    ${field({ label: "Phone", name: "phone", type: "tel", value: c.phone })}
    ${field({ label: "Email", name: "email", type: "email", value: c.email })}
    ${field({ label: "Website", name: "website", type: "url", value: c.website, inputmode: "url", autocapitalize: "none" })}
    ${field({ label: "Shop (where distances are measured from)", name: "base_label", value: (c.base && c.base.label) || "" })}
    <div class="grid2">
      ${field({ label: "Latitude", name: "base_lat", value: c.base && c.base.lat != null ? String(c.base.lat) : "", inputmode: "decimal" })}
      ${field({ label: "Longitude", name: "base_lng", value: c.base && c.base.lng != null ? String(c.base.lng) : "", inputmode: "decimal" })}
    </div>
    <button type="submit" class="btn primary block">Save</button>
  </form>`;
}

function hours(s) {
  const h = s.hours.data;
  const cal = s.calendar.data;
  return html`<form class="card form" id="f" novalidate>
    <div class="err" data-form-err hidden></div>
    <p class="small">When the office is open: the website shows these, "anytime" visits use them, and the first text to a new lead waits for them.</p>
    <div class="daygrid">${DAYS.map((d, i) => {
      const span = h[String(i)];
      return html`<span class="dn">${d.slice(0, 3)}</span>
        <input ${attrs({ type: "time", name: `from_${i}`, value: span ? span[0] : "08:00", "aria-label": `${d} opens`, disabled: !span })}>
        <input ${attrs({ type: "time", name: `to_${i}`, value: span ? span[1] : "17:00", "aria-label": `${d} closes`, disabled: !span })}>
        <label class="check tap"><input ${attrs({ type: "checkbox", name: `open_${i}`, checked: !!span, "data-day": String(i), "aria-label": `Open ${d}` })}></label>`;
    })}</div>
    <div class="section-h">Holidays</div>
    <p class="small">No marketing texts on these days; the schedule warns about them.</p>
    ${checkbox({ label: "Thanksgiving (4th Thursday of November)", name: "rule_thanksgiving", checked: (cal.rules || []).includes("thanksgiving") })}
    ${checkbox({ label: "Christmas Day", name: "rule_christmas", checked: (cal.rules || []).includes("christmas") })}
    <div class="stat-row">${(s.dates || []).map((d) => html`<button type="button" class="chip" data-del-date="${d}" aria-label="${`Remove ${d}`}">${dateShort(d)} ✕</button>`)}</div>
    <div class="copy-box"><input type="date" name="new_date" aria-label="Add a holiday"><button type="button" class="btn dark" data-add-date>${icon("plus")}Add</button></div>
    <button type="submit" class="btn primary block">Save</button>
  </form>`;
}

function area(s) {
  const a = s.area.data;
  return html`<form class="card form" id="f" novalidate>
    <div class="err" data-form-err hidden></div>
    <p class="small">Addresses outside get a "check the service area" flag for a person to look at, never an automatic no.</p>
    <div class="grid2">
      ${field({ label: "Center latitude", name: "lat", value: a.center && a.center.lat != null ? String(a.center.lat) : "", inputmode: "decimal" })}
      ${field({ label: "Center longitude", name: "lng", value: a.center && a.center.lng != null ? String(a.center.lng) : "", inputmode: "decimal" })}
    </div>
    ${field({ label: "Radius (miles)", name: "radius_mi", value: a.radius_mi != null ? String(a.radius_mi) : "", inputmode: "numeric" })}
    <label class="field" data-field="towns"><span>Towns (one per line)</span><textarea name="towns" rows="5">${(a.towns || []).map((t) => (typeof t === "string" ? t : t.city || t.slug || "")).join("\n")}</textarea><small class="why" hidden></small></label>
    <label class="field" data-field="zips"><span>ZIP codes</span><textarea name="zips" rows="3" inputmode="numeric">${(a.zips || []).join(", ")}</textarea><small class="why" hidden></small></label>
    <button type="submit" class="btn primary block">Save</button>
  </form>`;
}

const num = (v) => (String(v || "").trim() === "" ? undefined : Number(v));

export default {
  async load(params, ctx) {
    const section = sectionOf(ctx.path);
    if (section === "hours") {
      const [h, cal] = await Promise.all([loadDoc(ctx, "hours"), loadDoc(ctx, "calendar")]);
      return { section, hours: h, calendar: cal, dates: [...(cal.data.dates || [])] };
    }
    if (section === "area") return { section, area: await loadDoc(ctx, "service_area") };
    return { section, company: await loadDoc(ctx, "company") };
  },
  render(s) {
    return html`<div class="stack">${s.section === "hours" ? hours(s) : s.section === "area" ? area(s) : company(s)}</div>`;
  },
  events: {
    "change [data-day]": (e, el, ctx) => {
      const i = el.getAttribute("data-day");
      const form = el.closest("form");
      for (const n of [`from_${i}`, `to_${i}`]) form.querySelector(`[name="${n}"]`).disabled = !el.checked;
    },
    "click [data-add-date]": (e, el, ctx) => {
      const input = el.closest("form").querySelector("[name=new_date]");
      if (!input.value) { toast("Pick a date first."); return; }
      if (!ctx.state.dates.includes(input.value)) ctx.state.dates = [...ctx.state.dates, input.value].sort();
      ctx.rerender();
    },
    "click [data-del-date]": (e, el, ctx) => {
      ctx.state.dates = ctx.state.dates.filter((d) => d !== el.getAttribute("data-del-date"));
      ctx.rerender();
    },
    "submit #f": async (e, form, ctx) => {
      e.preventDefault();
      clearErrors(form);
      const v = readForm(form);
      const btn = form.querySelector("button[type=submit]");
      busy(btn, true);
      const s = ctx.state;
      try {
        if (s.section === "company") {
          const base = { label: v.base_label || undefined, lat: num(v.base_lat), lng: num(v.base_lng) };
          await saveDoc(ctx, s.company, { ...s.company.data, name: v.name, legal_name: v.legal_name, phone: v.phone, email: v.email, website: v.website, base });
        } else if (s.section === "hours") {
          const h = {};
          for (let i = 0; i < 7; i++) h[String(i)] = form.querySelector(`[name=open_${i}]`).checked ? [form.querySelector(`[name=from_${i}]`).value, form.querySelector(`[name=to_${i}]`).value] : null;
          await saveDoc(ctx, s.hours, h);
          const rules = [v.rule_thanksgiving ? "thanksgiving" : null, v.rule_christmas ? "christmas" : null].filter(Boolean);
          await saveDoc(ctx, s.calendar, { ...s.calendar.data, rules, dates: s.dates });
        } else {
          await saveDoc(ctx, s.area, { ...s.area.data, center: { lat: num(v.lat), lng: num(v.lng) }, radius_mi: num(v.radius_mi), towns: list(v.towns), zips: list(v.zips) });
        }
        toast("Saved");
        busy(btn, false);
      } catch (err) {
        busy(btn, false);
        if (err.status !== 412) showError(form, err);
      }
    },
  },
};
