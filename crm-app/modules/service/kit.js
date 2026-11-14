// Pieces the Service screens share (the Rotor guide's Service section:
// scratchpad simplify/guide-gaps.md §2.9): the stylesheet, the words for a
// request's status and source, the services a request can name, and a
// request's Row2. No data here, only how things read (design §2.3).

import { html, listRow } from "../../core/ui.js";
import { ago } from "../../core/format.js";

let styled = false;
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/service/service.css";
  document.head.appendChild(l);
}

export const STATUS = { new: "New", assessment_booked: "Assessment booked", assessed: "Assessed", converted: "Converted", closed: "Closed" };
export const STATUS_TONE = { new: "blue", assessment_booked: "amber", assessed: "amber", converted: "green", closed: "grey" };
export const SOURCE = { portal: "Portal", website: "Website", phone: "Phone", office: "Office", import: "Rotor" };
export const SERVICES = ["Exterior windows", "Interior windows", "Screens", "Gutters", "Christmas lights", "House wash", "Other"];
export const TIMING = ["As soon as you can", "This month", "Next month", "In the spring", "Just a price for now"];
export const CLOSE_REASONS = [["no_answer", "Couldn't reach them"], ["not_interested", "Not interested"], ["too_far", "Too far out"], ["duplicate", "A duplicate"], ["spam", "Spam"], ["other", "Other"]];

export const statusPill = (st) => ({ label: STATUS[st] || st, tone: STATUS_TONE[st] || "grey" });

// Row2: the name and the first service; the source, how long ago, photos, the status.
export function requestRow(r) {
  const svc = (r.svc || []);
  return listRow({
    title: r.cn || "No name", amount: svc.length ? `${svc[0]}${svc.length > 1 ? ` +${svc.length - 1}` : ""}` : "",
    sub: [SOURCE[r.src] || r.src, ago(r.at), r.ad && r.st === "assessment_booked" ? `look ${r.ad.slice(5).replace("-", "/")}` : null, r.ph ? `${r.ph} photo${r.ph === 1 ? "" : "s"}` : null].filter(Boolean).join(" · "),
    pill: statusPill(r.st), href: "#/requests/" + encodeURIComponent(r.id),
  });
}

export const emptyText = { open: "No open requests. Requests from the portal, the website and the phone land here.", assess_week: "No assessments booked this week.", unassigned: "Every open request has someone on it.", converted: "Nothing became work yet this year.", closed: "Nothing closed this year." };
export { html };
