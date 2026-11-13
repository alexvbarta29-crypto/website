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

test("Leads: one card per lead, priority, stage, PV and follow-up from what the CRM already has", () => {
  const ix = [{ id: "ct_1", n: `Avery ${XSS}`, lc: "lead", p: ["7635550101"] }, { id: "ct_2", n: "Blair Sample", lc: "lead", p: [] }, { id: "ct_3", n: "Casey Customer", lc: "customer" }];
  const cards = L.leadCards(ix, {
    enrollments: [{ c: "ct_1", lbl: "Day 1 call", due: "2026-11-18T15:00:00.000Z", st: "active" }],
    deals: [{ c: "ct_1", v: 42000, st: "open" }, { c: "ct_2", v: null, st: "quoted" }],
    tasks: [{ c: "ct_1", pr: "high" }, { c: "ct_1", pr: "low" }],
  });
  assert.deepEqual(cards.map((c) => [c.id, c.priority, c.stage, c.pv, !!c.follow]), [["ct_1", "high", "Day 1 call", 42000, true], ["ct_2", null, "Quoted", null, false]], "leads only; the nearest follow-up first");
  const h = String(L.leadCard(cards[0]));
  assert.ok(!h.includes("<script>alert(1)"), "escaped");
  assert.match(h, /High/);
  assert.match(h, /\$420/);
  assert.match(h, /href="tel:\+17635550101"/);
  assert.match(h, /data-convert="ct_1"/);
  assert.match(String(L.leadCard(cards[1])), />-</, "no PV or follow-up: -");
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
