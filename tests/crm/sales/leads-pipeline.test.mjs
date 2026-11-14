// Leads and Pipeline (the Nov 2026 layout, after Rotor's): a lead's card
// (priority from their open task, the stage from their follow-up, PV from
// the open deal, the next follow-up day), and a pipeline's stages (the
// cadence's steps, or a board-only pipeline's stages) with their cards and
// totals. Pure functions over the reads the screens make; escaped.
import { test } from "node:test";
import assert from "node:assert/strict";

const L = await import("../../../crm-app/modules/sales/leads.js");
const P = await import("../../../crm-app/modules/sales/pipeline.js");
const XSS = "</script><script>alert(1)</script>";

test("Leads (Rotor's, guide-gaps §2.6): the rows the server gives, searched, filtered and sorted; a row and a board card; escaped", () => {
  const rows = [
    { id: "ct_1", n: `Avery ${XSS}`, p: "7635550101", src: "Website", pr: "high", stage: "contacted", pv: 42000, follow: "2026-11-18T15:00:00.000Z", ca: "2026-11-10T10:00:00Z", sa: "2026-11-12T10:00:00Z", hand: true, lt: "2026-11-12T10:00:00Z", o: "us_1" },
    { id: "ct_2", n: "Blair Sample", p: null, src: "Referral", pr: null, stage: "new", pv: null, follow: null, ca: "2026-11-15T10:00:00Z" },
  ];
  assert.deepEqual(L.shownLeads(rows).map((r) => r.id), ["ct_2", "ct_1"], "newest first");
  assert.deepEqual(L.shownLeads(rows, { sort: "value" }).map((r) => r.id), ["ct_1", "ct_2"]);
  assert.deepEqual(L.shownLeads(rows, { show: ["follow"] }).map((r) => r.id), ["ct_1"]);
  assert.deepEqual(L.shownLeads(rows, { show: ["mine"], me: "us_1" }).map((r) => r.id), ["ct_1"]);
  assert.deepEqual(L.shownLeads(rows, { q: "blair" }).map((r) => r.id), ["ct_2"]);
  assert.deepEqual(L.shownLeads(rows, { tile: "contacted" }).map((r) => r.id), ["ct_1"]);
  assert.deepEqual(L.STAGES.map(([k]) => k), ["new", "contacted", "quoted", "follow_up", "sold", "not_interested", "not_ready"]);
  const h = String(L.leadRow(rows[0]));
  assert.ok(!h.includes("<script>alert(1)"), "escaped");
  assert.match(h, /\$420/);
  assert.match(h, /href="tel:\+17635550101"/);
  assert.match(h, /Contacted/);
  assert.match(h, /data-lead-more="ct_1"/);
  const c = String(L.leadCardHtml(rows[0], { users: new Map([["us_1", "OO"]]), now: Date.parse("2026-11-17T15:00:00Z") }));
  assert.match(c, /data-move="ct_1"/);
  assert.match(c, /5 d in stage/);
  assert.match(c, /Last contact Nov 12/);
  assert.match(c, /OO/);
  assert.match(String(L.leadRow(rows[1])), /New/);
});

test("Pipeline: stages from the cadence's steps (or a board's stages), cards in their stage, totals per stage", () => {
  const cad = { board_only: false, steps: [{ label: "New" }, { label: "Called" }, { label: "Quoted" }] };
  const rows = [{ id: "en_1", c: "ct_1", cn: "Avery Lead", lbl: "Called", n: 2, st: "active", due: "2026-11-18T15:00:00.000Z" }, { id: "en_2", c: "ct_2", cn: "Blair Sample", lbl: "", n: 1, st: "paused" }];
  const st = P.board(cad, rows, { deals: [{ c: "ct_1", v: 30000 }], index: [{ id: "ct_1", lc: "lead", p: ["7635550101"] }, { id: "ct_2", lc: "customer" }] });
  assert.deepEqual(st.map((s) => [s.name, s.cards.map((c) => c.id), s.total]), [["New", ["en_2"], 0], ["Called", ["en_1"], 30000], ["Quoted", [], 0]]);
  assert.deepEqual([st[1].cards[0].type, st[0].cards[0].type, st[0].cards[0].status], ["Lead", "Customer", "Paused"]);
  const b = P.board({ board_only: true, board_stages: ["New", "In Progress"] }, [{ id: "en_3", c: "ct_3", cn: "Casey", lbl: "In Progress", n: 1, st: "active" }]);
  assert.deepEqual(b.map((s) => [s.name, s.cards.length]), [["New", 0], ["In Progress", 1]], "a board-only pipeline's stages");
  assert.deepEqual(P.board(null, []).map((s) => s.name), ["New"]);
});

test("Pipelines: the filter (open or paused, lead or customer, due today) and the search", () => {
  const cards = [{ id: "a", name: "Avery", status: "Open", type: "Lead", due: "2026-11-17T15:00:00.000Z" }, { id: "b", name: "Blair", status: "Paused", type: "Customer", due: "2026-11-20T15:00:00.000Z" }];
  assert.deepEqual(P.shownCards(cards, { f: { st: "paused" } }).map((c) => c.id), ["b"]);
  assert.deepEqual(P.shownCards(cards, { f: { type: "lead" } }).map((c) => c.id), ["a"]);
  assert.deepEqual(P.shownCards(cards, { f: { today: true } }, "2026-11-17").map((c) => c.id), ["a"]);
  assert.deepEqual(P.shownCards(cards, { q: "bla" }).map((c) => c.id), ["b"]);
});
