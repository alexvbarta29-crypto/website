// The Power Dialer's screens (guide-gaps §2.8): who is up now, the Dialer's
// card and script, the Call logs' tiles and rows; escaped.
import { test } from "node:test";
import assert from "node:assert/strict";

const D = await import("../../../crm-app/modules/sales/dialer.js");
const L = await import("../../../crm-app/modules/sales/call-logs.js");
const XSS = "</script><script>alert(1)</script>";
const ctx = { can: () => true, keep: {}, user: { id: "us_1" } };

test("who is up: a named queue's cursor, the kept one for Follow-up calls; the card, the script, the Call pill", () => {
  const rows = [{ id: "ct_1", n: `Avery ${XSS}`, p: "7635550101", lc: "lead", src: "Website", c: "Delano" }, { id: "ct_2", n: "Blair", p: null, lc: "customer" }];
  assert.equal(D.current({ ids: ["ct_2", "ct_1"], cursor: 1 }, rows).row.id, "ct_1");
  assert.equal(D.current({ ids: ["ct_1", "ct_2"], builtin: true }, rows, 1).row.id, "ct_2");
  assert.equal(D.current({ ids: [] }, []).row, null);
  const s = { queues: [{ id: "followups", name: "Follow-up calls", builtin: true }], qid: "followups", queue: { ids: ["ct_1", "ct_2"], builtin: true }, rows, scripts: [], script: { name: "New lead call", sections: [{ key: "opening", title: "Opening", body: "Hi" }] }, fcur: 0 };
  const h = String(D.default.render(s, ctx));
  assert.ok(!h.includes("<script>alert(1)"), "escaped");
  assert.match(h, /Calling from: this phone/);
  assert.match(h, /1 of 2/);
  assert.match(h, /href="tel:\+17635550101"/, "the sticky Call dials from this phone");
  assert.match(h, /data-dl-step="skip"/);
  assert.match(h, /<details class="dl-part" open/, "the script's first part open");
  assert.match(String(D.default.render({ ...s, rows: [], queue: { ids: [], builtin: true } }, ctx)), /Nobody to call/);
});

test("Call logs: seven tiles, a row per call with the outcome and '-' for no duration", () => {
  const t = L.statTiles({ total: 4, answered: 2, voicemails: 1, completed: 4, today: 2, avg_duration_s: null, per_hour: 2 });
  assert.deepEqual(t.map((x) => x.label), ["Total calls", "Answered", "Voicemails", "Completed", "Calls today", "Avg duration", "Calls per hour"]);
  assert.equal(t[5].value, "-");
  assert.ok(t.every((x) => x.info), "info only");
  const r = String(L.logRow({ c: "ct_1", cn: `Pat ${XSS}`, by: "us_1", out: "booked", at: "2026-11-17T15:00:00.000Z", dur: 95 }, new Map([["us_1", "Olive"]])));
  assert.ok(!r.includes("<script>alert(1)"));
  assert.match(r, /Booked/);
  assert.match(r, /Olive/);
  assert.match(r, /1:35/);
});
