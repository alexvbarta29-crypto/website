// The work card on Today (design §9.2 Today, the office): today's visits by
// person (tap to open their route), how many are still to book, and jobs
// that need a look. One schedule read and two small ones.

import { html, icon, attrs } from "../../core/ui.js";
import { plural } from "../../core/format.js";
import { ensureStyles, officeView, today, loadUsers, userById } from "./office-kit.js";

const DEAD = ["cancelled", "no_access"];

export default {
  async load(ctx) {
    ensureStyles();
    if (!officeView()) return { none: true };
    // the server's today (the phone's clock may be off)
    const [day, tray, stale, users] = await Promise.all([
      ctx.api("/schedule", { cache: false }).then((r) => r.data).catch(() => null),
      ctx.api("/schedule/unscheduled", { cache: false }).then((r) => r.data).catch(() => null),
      ctx.api("/stale", { cache: false }).then((r) => r.data).catch(() => null),
      loadUsers(ctx).catch(() => []),
    ]);
    return { date: (day && day.from) || today(), day, tray, stale, users };
  },
  render(s) {
    if (s.none || !s.day) return html``;
    const visits = (s.day.visits || []).filter((v) => !DEAD.includes(v.st));
    const by = new Map();
    for (const v of visits) for (const id of (v.a && v.a.length ? v.a : [""])) by.set(id, [...(by.get(id) || []), v]);
    const people = [...by.entries()].sort((a, b) => b[1].length - a[1].length);
    const doneN = visits.filter((v) => v.st === "completed").length;
    const toBook = s.tray ? s.tray.jobs.length : 0;
    const staleN = s.stale ? (s.stale.jobs || []).length : 0;
    return html`<div class="section-h">Today's visits</div>
      ${visits.length ? html`<ul class="list">${people.map(([uid, list]) => {
        const u = userById(s.users, uid);
        const left = list.filter((v) => v.st !== "completed").length;
        return html`<li><a class="row" href="${uid ? `#/schedule/route/${s.date}/${encodeURIComponent(uid)}` : "#/schedule"}"><span class="wk-dot big" ${attrs({ style: `background:${(u && u.color) || "#85858d"}` })}></span>
          <span class="who"><span class="nm">${u ? u.name : uid ? "Someone" : "Nobody assigned"}</span><span class="sub">${plural(list.length, "visit")}${left !== list.length ? `, ${left} to go` : ""}</span></span><span class="chev" aria-hidden="true"></span></a></li>`;
      })}</ul>` : html`<a class="tile" href="#/schedule">${icon("schedule")}<span>Nothing booked today</span></a>`}
      ${toBook || staleN || doneN ? html`<div class="links wk-todaylinks">
        ${toBook ? html`<a class="tile" href="#/schedule?view=tray">${icon("list")}<span>${plural(toBook, "job")} to book</span><span class="n">${toBook}</span></a>` : ""}
        ${staleN ? html`<a class="tile" href="#/jobs?status=stale">${icon("bell")}<span>${plural(staleN, "job")} need${staleN === 1 ? "s" : ""} a look</span><span class="n">${staleN}</span></a>` : ""}
      </div>` : ""}`;
  },
};
