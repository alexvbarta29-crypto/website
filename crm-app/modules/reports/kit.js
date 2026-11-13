// Pieces the reports screens share: the stylesheet, initials avatars.
import { html, attrs } from "../../core/ui.js";
import { initials } from "../../core/format.js";

let styled = false;
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/reports/reports.css";
  document.head.appendChild(l);
}
export const avatar = (p, cls = "") => html`<span ${attrs({ class: "rp-av " + cls, style: p && /^#[0-9a-f]{6}$/i.test(p.color || "") ? `background:${p.color}` : null, "aria-hidden": "true" })}>${p ? p.initials || initials(p.name) : "?"}</span>`;
export const PERIOD_LABEL = { today: "Today", week: "This week", month: "This month", year: "This year" };
