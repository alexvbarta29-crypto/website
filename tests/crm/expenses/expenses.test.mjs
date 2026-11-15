// The expenses module (Flyra's Expenses; guide-gaps S37): add once per
// tap, the list by period and category with totals, edit with If-Match, a
// receipt file owned by the expense, delete; techs see none of it; the
// expenses.totals service for profit. Synthetic data only; a pinned clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, store, AS } from "../work-office/fixtures.mjs";
import { BYTES } from "../../helpers/crm-fixtures.mjs";

const EX = await import("../../../netlify/lib/crm/modules/expenses/index.mjs");
const services = await import("../../../netlify/lib/crm/core/services.mjs");
const cid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("totalsOf (pure): in the period, by category, newest first", () => {
  const rows = [{ id: "a", d: "2026-11-02", a: 1000, cat: "fuel" }, { id: "b", d: "2026-11-10", a: 2500, cat: "supplies" }, { id: "c", d: "2026-10-30", a: 9999, cat: "fuel" }, { id: "d", d: "2026-11-11", a: 500, cat: "fuel" }];
  const t = EX.totalsOf(rows, "2026-11-01", "2026-11-30");
  assert.equal(t.total_cents, 4000);
  assert.deepEqual(t.by_category, { fuel: { n: 2, cents: 1500 }, supplies: { n: 1, cents: 2500 } });
  assert.deepEqual(t.rows.map((r) => r.id), ["d", "b", "a"]);
  assert.deepEqual(EX.totalsOf(rows, "2026-11-01", "2026-11-30", "fuel").rows.map((r) => r.id), ["d", "a"]);
});

test("expenses: add once per tap, list and totals, edit, a receipt, delete; techs see none of it", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    const body = { client_id: cid(1), date: "2026-11-16", amount_cents: 4599, category: "supplies", vendor: "Example Hardware <b>", note: "Squeegee rubbers" };
    const a = await t.api("/expenses", { method: "POST", as: admin, body });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const ex = a.body.data.expense;
    assert.equal(ex.paid_by, admin.id);
    assert.equal((await t.api("/expenses", { method: "POST", as: admin, body })).body.data.expense.id, ex.id, "a double tap is one expense");
    for (const bad of [{ amount_cents: 0 }, { amount_cents: 1.5 }, { category: "yachts" }, { date: "11/16/2026" }]) {
      assert.equal((await t.api("/expenses", { method: "POST", as: owner, body: { ...body, client_id: cid(9), ...bad } })).status, 400, JSON.stringify(bad));
    }
    await t.api("/expenses", { method: "POST", as: owner, body: { client_id: cid(2), date: "2026-11-03", amount_cents: 6000, category: "fuel" } });
    await t.api("/expenses", { method: "POST", as: owner, body: { client_id: cid(3), date: "2026-10-20", amount_cents: 7000, category: "fuel" } });
    const l = await t.api("/expenses", { as: owner });
    assert.equal(l.status, 200);
    assert.equal(l.body.meta.from, "2026-11-01", "this month by default");
    assert.equal(l.body.meta.total_cents, 10599);
    assert.deepEqual(l.body.meta.by_category, { supplies: { n: 1, cents: 4599 }, fuel: { n: 1, cents: 6000 } });
    const f = await t.api("/expenses?from=2026-10-01&to=2026-11-30&cat=fuel", { as: owner });
    assert.equal(f.body.data.length, 2);
    assert.equal(f.body.meta.total_cents, 17599, "the tiles keep every category");
    assert.equal((await t.api("/expenses?cat=yachts", { as: owner })).status, 400);
    assert.equal((await t.api("/expenses", { as: tech })).status, 403);
    assert.equal((await t.api(`/expenses/${ex.id}`, { as: tech })).status, 403);
    // edit with the version read; the receipt is a file the expense owns
    const g = await t.api(`/expenses/${ex.id}`, { as: owner });
    assert.equal((await t.api(`/expenses/${ex.id}`, { method: "PATCH", as: owner, body: { amount_cents: 5000 } })).status, 400, "If-Match");
    const p = await t.api(`/expenses/${ex.id}`, { method: "PATCH", as: owner, body: { amount_cents: 5000, vendor: "" }, ifMatch: g.headers.get("etag") });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.data.expense.amount_cents, 5000);
    assert.equal(p.body.data.expense.vendor, undefined);
    const up = await t.api(`/files?owner_type=expense&owner_id=${ex.id}&kind=photo`, { method: "POST", as: admin, raw: BYTES.jpeg(), headers: { "content-type": "image/jpeg" } });
    assert.ok([200, 201].includes(up.status), JSON.stringify(up.body));
    assert.equal((await t.api(`/files?owner_type=expense&owner_id=${ex.id}&kind=photo`, { method: "POST", as: tech, raw: BYTES.jpeg(), headers: { "content-type": "image/jpeg" } })).status, 403, "a tech can't add a receipt");
    const g2 = await t.api(`/expenses/${ex.id}`, { as: owner });
    assert.equal((await t.api(`/expenses/${ex.id}`, { method: "PATCH", as: owner, body: { receipt_id: up.body.data.file.id }, ifMatch: g2.headers.get("etag") })).body.data.expense.receipt_id, up.body.data.file.id);
    assert.deepEqual(await services.call("expenses.totals", "2026-11-01", "2026-11-30"), { total_cents: 11000, by_category: { supplies: { n: 1, cents: 5000 }, fuel: { n: 1, cents: 6000 } } });
    assert.equal((await t.api(`/expenses/${ex.id}`, { method: "DELETE", as: owner })).status, 200);
    assert.equal((await t.api(`/expenses/${ex.id}`, { as: owner })).status, 404);
    assert.equal((await t.api("/expenses", { as: owner })).body.meta.total_cents, 6000);
    void store; void AS;
  } finally { t.done(); }
});
