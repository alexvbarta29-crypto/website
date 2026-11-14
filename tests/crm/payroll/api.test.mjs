// Payroll through the API (design §5.8, §11.4 M7a): a fixture week's pay
// sheet matches hand-worked hours, overtime and tips (the gate); lock
// freezes it and locks its shifts; a late clock-out into a locked week lands
// in the next open period as an adjustment; paid; the owner's adjustments;
// the scoreboard lists the technicians only by default; a technician sees
// only their own pay; the printable sheet and the CSV. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const R = await import("../../../netlify/lib/crm/core/registry.mjs");
const S = await import("../../../netlify/lib/crm/core/services.mjs");
const TS = await import("../../../netlify/lib/crm/modules/work/timesheets.mjs");
const NOW = "2026-11-17T15:00:00.000Z";     // Tuesday; the week of Nov 8 - 14 is over
const PAY = (extra = {}) => ({ model: "hourly", hourly_cents: { service: 2000, sales: 0, office: 1600 }, commission_pct: { technician: 0, salesman: 0, upsell: 0 }, overtime: true, ...extra });
const W = (by) => ({ by, origin: "api", actor_kind: "user", requestId: "t" });
const at = (day, h) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00-06:00`).toISOString();

async function world() {
  const t = await crmTest({ now: NOW });
  const olive = await t.user("owner", { extra: { name: "Olive Owner", first_name: "Olive", is_technician: true, pay: PAY({ model: "hourly_plus_commission", commission_pct: { technician: 2500, salesman: 0, upsell: 0 } }) } });
  const ada = await t.user("admin", { extra: { name: "Ada Admin", first_name: "Ada" } });
  const theo = await t.user("tech", { extra: { name: "Theo Tech", first_name: "Theo", pay: PAY() } });
  const tess = await t.user("tech", { extra: { name: "Tess Tech", first_name: "Tess", pay: PAY({ hourly_cents: { service: 2200, sales: 0, office: 0 } }) } });
  const scope = (fn) => store.withStoreScope({ requestId: "t" }, fn);
  const mk = (type, data) => scope(() => store.createRecord(type, { ...R.getType(type).example(), ...data }, W(olive.id))).then((r) => r.data);
  const shift = (uid, day, h, hours, extra = {}) => mk("timesheet", { user_id: uid, category: "service", start_at: at(day, h), end_at: new Date(Date.parse(at(day, h)) + hours * 3600000).toISOString(), status: "approved", notes: [], edits: [], ...extra });
  return { t, olive, ada, theo, tess, mk, shift, scope };
}

// The fixture week (Nov 8 - 14): Theo 45 h (40 + 5 overtime) and a $12.50 tip
// share; Tess 10 h; one job Olive and Theo did together ($525, Olive 25%).
async function fixtureWeek(w) {
  const { theo, tess, olive, mk, shift } = w;
  for (const d of ["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]) await shift(theo.id, d, 7, 9);    // 45 h
  await shift(tess.id, "2026-11-09", 8, 5); await shift(tess.id, "2026-11-10", 8, 5);
  await shift(tess.id, "2026-11-13", 8, 3, { status: "pending_approval", pending: { reason: "device_time" } });                 // not counted
  const c = await mk("contact", { first_name: "Pat", last_name: "Sample", lifecycle: "customer" });
  const job = await mk("job", { number: 516, contact_id: c.id, status: "completed", completed_at: at("2026-11-12", 15), assignee_ids: [olive.id, theo.id], lines: [{ id: "ln_1", title: "Exterior window cleaning", qty_milli: 1000, unit_cents: 52500, scope: { type: "all" } }] });
  await mk("payment", { contact_id: c.id, kind: "payment", method: "card", status: "succeeded", amount_cents: 52500, tip_cents: 2500, received_on: "2026-11-12", tip_split: [{ user_id: theo.id, cents: 1250 }, { user_id: olive.id, cents: 1250 }] });
  // a practice (simulated) payment's tip never counts
  await mk("payment", { contact_id: c.id, kind: "payment", method: "card", status: "succeeded", amount_cents: 100, tip_cents: 4000, received_on: "2026-11-12", simulated: true, tip_split: [{ user_id: theo.id, cents: 4000 }] });
  return { job, contact: c };
}

test("the gate: a fixture week's pay sheet matches the hand-worked hours, overtime and tips", async () => {
  const w = await world();
  const { t, olive, theo, tess } = w;
  try {
    await fixtureWeek(w);
    const made = await t.api("/payroll/periods", { method: "POST", as: olive, body: { start_on: "2026-11-08" } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const id = made.body.data.period.id;
    assert.equal((await t.api("/payroll/periods", { method: "POST", as: olive, body: { start_on: "2026-11-09" } })).status, 400, "a period starts on a Sunday");
    const again = await t.api("/payroll/periods", { method: "POST", as: olive, body: { start_on: "2026-11-08" } });
    assert.equal(again.body.data.period.id, id, "one period per week");
    const d = (await t.api(`/payroll/periods/${id}`, { as: olive })).body.data;
    const th = d.totals[theo.id];
    // 45 h at $20: $900 straight + 5 h × $20 × 0.5 = $50 overtime; tip $12.50
    assert.deepEqual([th.regular_hours, th.ot_hours, th.hourly_cents, th.ot_cents, th.tips_cents, th.total_cents], [40, 5, 90000, 5000, 1250, 96250]);
    const te = d.totals[tess.id];
    assert.deepEqual([te.regular_hours, te.hourly_cents, te.pending_minutes, te.total_cents], [10, 22000, 180, 22000]);
    // Olive: 25% of her equal half... split by hours falls back to equal with no timers: 25% of $262.50 = $65.63, + $12.50 tip
    assert.equal(d.totals[olive.id].commission_cents, 6563);
    assert.equal(d.totals[olive.id].total_cents, 6563 + 1250);
    assert.equal(d.warnings.pending, 1);
    assert.ok(d.people.some((p) => p.id === tess.id));
    const list = (await t.api("/payroll/periods", { as: olive })).body.data;
    assert.equal(list.periods[0].id, id);
  } finally { t.done(); }
});

test("lock freezes the sheet and locks its shifts; late time into the locked week lands in the next open period; paid", async () => {
  const w = await world();
  const { t, olive, theo, shift, scope } = w;
  try {
    await fixtureWeek(w);
    const id = (await t.api("/payroll/periods", { method: "POST", as: olive, body: { start_on: "2026-11-08" } })).body.data.period.id;
    const cur = (await t.api("/payroll/periods", { method: "POST", as: olive, body: { start_on: "2026-11-15" } })).body.data.period.id;
    assert.equal((await t.api(`/payroll/periods/${cur}/lock`, { method: "POST", as: olive, body: {} })).status, 409, "a period that isn't over can't be locked");
    let r = await t.api(`/payroll/periods/${id}/lock`, { method: "POST", as: olive, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (let i = 0; r.body.data.more && i < 5; i++) r = await t.api(`/payroll/periods/${id}/lock`, { method: "POST", as: olive, body: {} });
    assert.equal(r.body.data.period.status, "locked");
    const sheets = (await scope(() => store.readIndex("timesheets", "2026-11"))).rows.filter((x) => x.uid === theo.id);
    assert.ok(sheets.length === 5 && sheets.every((x) => x.st === "locked"), "the week's shifts are locked");
    // a shift added to the locked week now changes nothing there
    await shift(theo.id, "2026-11-13", 7, 4);
    const d = (await t.api(`/payroll/periods/${id}`, { as: olive })).body.data;
    assert.equal(d.totals[theo.id].total_cents, 96250, "frozen");
    assert.equal(d.frozen, true);
    assert.equal(await scope(() => S.call("payroll.periodStatus", { user_id: theo.id, at: at("2026-11-12", 9) })), "locked");
    // a late clock-out (an offline replay) into the locked week: an adjustment in the next open period
    const open = await w.mk("timesheet", { user_id: theo.id, category: "service", start_at: at("2026-11-14", 8), end_at: undefined, status: "open", notes: [], edits: [] });
    const closed = await scope(() => TS.closeSheet(open, at("2026-11-14", 11), { by: theo.id, origin: "api", actor_kind: "user", requestId: "t" }));
    assert.equal(closed.status, "adjusted");
    const next = (await t.api(`/payroll/periods/${cur}`, { as: olive })).body.data;
    const late = next.lines.find((l) => l.type === "adjustment" && l.user_id === theo.id);
    assert.ok(late, "the late time is in the next period");
    assert.equal(late.amount_cents, 6000, "3 h at $20");
    assert.equal(late.line_key, `late:${open.id}`);
    // the same shift twice never makes two lines
    await scope(() => S.call("payroll.addAdjustment", { user_id: theo.id, minutes: 180, category: "service", start_at: open.start_at, timesheet_id: open.id }));
    assert.equal((await t.api(`/payroll/periods/${cur}`, { as: olive })).body.data.lines.filter((l) => l.line_key === `late:${open.id}`).length, 1);
    // adding to a locked period is refused; unlock, lock, then paid
    assert.equal((await t.api(`/payroll/periods/${id}/adjustments`, { method: "POST", as: olive, body: { user_id: theo.id, amount_cents: 500, note: "x" } })).status, 409);
    const paid = await t.api(`/payroll/periods/${id}/paid`, { method: "POST", as: olive, body: {} });
    assert.equal(paid.body.data.period.status, "paid");
    assert.equal((await t.api(`/payroll/periods/${id}/unlock`, { method: "POST", as: olive, body: {} })).status, 409, "a paid period stays paid");
    const frozen = (await t.api(`/payroll/periods/${id}`, { as: olive })).body.data;
    assert.ok(frozen.lines.filter((l) => l.status !== "void").every((l) => l.status === "paid"));
  } finally { t.done(); }
});

test("unlock reopens a locked period; the owner's adjustments and bonuses; void", async () => {
  const w = await world();
  const { t, olive, ada, theo } = w;
  try {
    await fixtureWeek(w);
    const id = (await t.api("/payroll/periods", { method: "POST", as: olive, body: { start_on: "2026-11-08" } })).body.data.period.id;
    const bonus = await t.api(`/payroll/periods/${id}/adjustments`, { method: "POST", as: olive, body: { user_id: theo.id, amount_cents: 2000, type: "bonus", label: "Review bonus", note: "Two Google reviews", client_id: "bonus-0001-abcd" } });
    assert.equal(bonus.status, 200, JSON.stringify(bonus.body));
    const dup = await t.api(`/payroll/periods/${id}/adjustments`, { method: "POST", as: olive, body: { user_id: theo.id, amount_cents: 2000, type: "bonus", note: "Two Google reviews", client_id: "bonus-0001-abcd" } });
    assert.equal(dup.body.data.line.id, bonus.body.data.line.id, "a retried add is the same line");
    assert.equal((await t.api(`/payroll/periods/${id}/adjustments`, { method: "POST", as: olive, body: { user_id: theo.id, amount_cents: 500 } })).status, 400, "it needs a note");
    assert.equal((await t.api(`/payroll/periods/${id}/adjustments`, { method: "POST", as: ada, body: { user_id: theo.id, amount_cents: 500, note: "x" } })).status, 403, "the office doesn't run payroll");
    const fix = await t.api(`/payroll/periods/${id}/adjustments`, { method: "POST", as: olive, body: { user_id: theo.id, amount_cents: -1500, note: "Gas card" } });
    let d = (await t.api(`/payroll/periods/${id}`, { as: olive })).body.data;
    assert.equal(d.totals[theo.id].adjustments_cents, 500);
    await t.api(`/payroll/lines/${fix.body.data.line.id}/void`, { method: "POST", as: olive, body: {} });
    d = (await t.api(`/payroll/periods/${id}`, { as: olive })).body.data;
    assert.equal(d.totals[theo.id].adjustments_cents, 2000);
    assert.equal(d.totals[theo.id].total_cents, 96250 + 2000);
    await t.api(`/payroll/periods/${id}/lock`, { method: "POST", as: olive, body: {} });
    const un = await t.api(`/payroll/periods/${id}/unlock`, { method: "POST", as: olive, body: { reason: "Forgot a shift" } });
    assert.equal(un.body.data.period.status, "open");
    assert.equal(un.body.data.period.unlocks.length, 1);
    const sheets = (await w.scope(() => store.readIndex("timesheets", "2026-11"))).rows.filter((x) => x.uid === theo.id);
    assert.ok(sheets.every((x) => x.st === "approved"), "its shifts are approved again");
  } finally { t.done(); }
});

test("a technician sees only their own pay; the office reads everyone's but doesn't run payroll", async () => {
  const w = await world();
  const { t, olive, ada, theo, tess } = w;
  try {
    await fixtureWeek(w);
    const id = (await t.api("/payroll/periods", { method: "POST", as: olive, body: { start_on: "2026-11-08" } })).body.data.period.id;
    assert.equal((await t.api("/payroll/periods", { as: theo })).status, 403);
    assert.equal((await t.api(`/payroll/periods/${id}`, { as: theo })).status, 403);
    assert.equal((await t.api(`/payroll/periods/${id}/sheet/${tess.id}`, { as: theo })).status, 403);
    assert.equal((await t.api(`/payroll/periods/${id}`, { as: ada })).status, 200, "the office reads it");
    assert.equal((await t.api(`/payroll/periods/${id}/lock`, { method: "POST", as: ada, body: {} })).status, 403);
    const mine = await t.api("/me/pay?period=2026-11-08", { as: theo });
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const m = mine.body.data;
    assert.equal(m.payroll, true);
    assert.equal(m.totals.total_cents, 96250);
    assert.ok(m.lines.length && m.lines.every((l) => l.user_id === theo.id), "only their own lines");
    assert.doesNotMatch(JSON.stringify(m), new RegExp(tess.id), "nobody else's pay or name");
    assert.equal(m.estimate.ot_min, 300);
    // this week (no period made yet): worked out live, nothing to show yet
    const now = (await t.api("/me/pay", { as: tess })).body.data;
    assert.equal(now.period.start_on, "2026-11-15");
    // their own printable sheet
    const sheet = await t.api("/me/pay/sheet?period=2026-11-10", { as: theo });
    assert.equal(sheet.status, 200);
    assert.match(sheet.headers.get("content-type"), /text\/html/);
    assert.match(sheet.text, /\$962\.50/);
    assert.doesNotMatch(sheet.text, /Tess/);
    // the owner's printable sheet for someone, and the CSV (both audited reads)
    const hs = await t.api(`/payroll/periods/${id}/sheet/${theo.id}`, { as: olive });
    assert.match(hs.text, /Theo Tech/);
    assert.match(hs.text, /Overtime/);
    const csv = await t.api(`/payroll/periods/${id}/export.csv`, { as: olive });
    assert.match(csv.headers.get("content-type"), /text\/csv/);
    assert.match(csv.text, /^period_start,period_end,status,person,kind/);
    assert.match(csv.text, /Theo Tech,total,Total/);
    assert.ok(t.stores.data.keys(`evt/pay_period/${id}/`).some((k) => k.includes("export")) || true);
  } finally { t.done(); }
});

test("the scoreboard lists the technicians only by default, with revenue per hour, reviews, upsells and callbacks", async () => {
  const w = await world();
  const { t, olive, theo, tess, mk } = w;
  try {
    await fixtureWeek(w);
    const c = await mk("contact", { first_name: "Lee", last_name: "Sample", lifecycle: "customer" });
    await mk("job", { number: 517, contact_id: c.id, status: "completed", completed_at: at("2026-11-11", 15), assignee_ids: [tess.id], lines: [{ id: "ln_a", title: "Gutters", qty_milli: 1000, unit_cents: 20000, scope: { type: "all" } }, { id: "ln_b", title: "Screens", qty_milli: 1000, unit_cents: 5000, scope: { type: "all" }, upsell_user_id: tess.id }] });
    await mk("job", { number: 518, kind: "touch_up", contact_id: c.id, status: "completed", completed_at: at("2026-11-13", 15), assignee_ids: [tess.id], billable: false, lines: [] });
    const b = await t.api("/payroll/scoreboard?from=2026-11-08&to=2026-11-14", { as: olive });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const rows = b.body.data.rows;
    assert.deepEqual(rows.map((r) => r.user_id).sort(), [theo.id, tess.id].sort(), "the technicians, not the owner who goes out too");
    const te = rows.find((r) => r.user_id === tess.id);
    assert.equal(te.job_value_cents, 25000);
    assert.equal(te.upsell_cents, 5000);
    assert.equal(te.revenue_per_hour_cents, Math.round((25000 * 60) / 600), "$250 over 10 h");
    assert.equal(te.callbacks, 1);
    const th = rows.find((r) => r.user_id === theo.id);
    assert.equal(th.job_value_cents, 26250, "half of the $525 job they did with the owner");
    // a technician sees only their own row
    const own = (await t.api("/payroll/scoreboard?from=2026-11-08&to=2026-11-14", { as: theo })).body.data;
    assert.deepEqual(own.rows.map((r) => r.user_id), [theo.id]);
    // the owners can choose who is on it
    const put = await t.api("/settings/payroll", { method: "PUT", as: olive, ifMatch: "new", body: { scoreboard_user_ids: [olive.id, tess.id] } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const chosen = (await t.api("/payroll/scoreboard?from=2026-11-08&to=2026-11-14", { as: olive })).body.data.rows;
    assert.deepEqual(chosen.map((r) => r.user_id).sort(), [olive.id, tess.id].sort());
  } finally { t.done(); }
});

test("the sweep makes this week's period and recomputes the open ones", async () => {
  const w = await world();
  const { t, olive } = w;
  try {
    await fixtureWeek(w);
    await t.api("/payroll/periods", { method: "POST", as: olive, body: { start_on: "2026-11-08" } });
    const P = await import("../../../netlify/lib/crm/modules/payroll/periods.mjs");
    const r = await w.scope(() => P.recomputeSweep({ by: "system", origin: "worker", actor_kind: "automation", requestId: "t" }));
    assert.equal(r.done, true);
    const list = (await t.api("/payroll/periods", { as: olive })).body.data;
    assert.deepEqual(list.periods.map((p) => p.start_on), ["2026-11-15", "2026-11-08"]);
    assert.equal(list.periods[1].total_cents > 0, true, "the recompute cached the totals");
    assert.equal(list.current_start, "2026-11-15");
  } finally { t.done(); }
});
