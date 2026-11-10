// M2b acceptance: the estimate follow-up's texts are read before they go
// (design §11.4 "review-before-send.test.mjs", D21, barta-rules §3.2: "Read
// before you send... Don't fire these off word-for-word"). Every step opens
// the compose sheet on no answer; text_anyway is refused on that cadence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeLead, enrollment, outbox, pin, E, SEED, AUTO } from "./fixtures.mjs";

test("every estimate follow-up step opens the compose sheet on no answer; nothing goes out until a person sends it", async () => {
  const { t, owner } = await setup();
  try {
    const c = await makeLead(owner);
    // a sent quote (Quotes, M3a): the offer steps land on it, the archive step archives it
    const made = await t.api("/quotes", { method: "POST", as: owner, body: { contact_id: c.id, options: [{ name: "One-time", kind: "one_time", recommended: true, lines: [{ title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, category: "windows_ext" }] }] } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const QUOTE = made.body.data.id;
    assert.equal((await t.api(`/quotes/${QUOTE}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } })).status, 200);
    const id = await E.enroll(c.id, "estimate_followup", { quote_id: QUOTE }, { by: owner.id, origin: "api", actor_kind: "user", requestId: "x" });
    const cad = SEED.seedCadence("estimate_followup");
    assert.ok(cad.steps.every((s) => s.review_before_send), "every step is read before sending");
    for (let n = 1; n <= cad.steps.length; n++) {
      const e = await enrollment(id);
      assert.equal(e.step_n, n);
      assert.equal(e.cur.rbs, true);
      const before = outbox(t).length;
      const call = await t.api("/calls", { method: "POST", as: owner, body: { contact_id: c.id, enrollment_id: id, outcome: "no_answer" } });
      assert.equal(call.status, 200, JSON.stringify(call.body));
      const next = call.body.data.next;
      assert.equal(next.kind, "compose", `step ${n} opens the compose sheet`);
      assert.equal(next.template_key, `cad_est_${n}`);
      assert.ok(next.text.startsWith("Hey Pat"), "prefilled with the step's text");
      assert.equal(outbox(t).length, before, "nothing sent on the call alone");
      assert.equal((await enrollment(id)).pending.kind, "compose");
      // the person adjusts the words, sends (dry-run: by hand through Messages)
      const words = `${next.text} (we talked about the back porch)`;
      const sent = await t.api(`/cadence-steps/${id}/${n}/send`, { method: "POST", as: owner, body: { body: words, hand: "sms_link" } });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.equal(outbox(t).length, before + 1, "their words, in the Outbox");
      assert.ok(outbox(t).some((o) => o.body.includes("back porch")));
      const after = await enrollment(id);
      const h = after.history.filter((x) => x.n === n && x.action === "text")[0];
      assert.equal(h.edited, true);
      assert.equal(h.sent_by_hand, "sms_link");
      if (n === 3) assert.equal(h.offer, "followup_50", "the $50 offer lands on the quote");
      if (n === 4) assert.equal(h.offer, "ten_free_screens");
      if (n === 5) assert.equal(h.archived, true);
      pin(new Date(Date.parse(after.next_due_at || "2026-11-25T15:00:00Z") + 5 * 60000).toISOString());
    }
    const done = await enrollment(id);
    assert.equal(done.status, "completed");
    assert.equal((await t.api(`/deals/${done.deal_id}`, { as: owner })).body.data.deal.status, "lost", "the archive step closes the deal (no response)");
    const q = (await t.api(`/quotes/${QUOTE}`, { as: owner })).body.data.quote;
    assert.equal(q.status, "archived");
    assert.equal(q.archive_reason, "cadence_expired");
    assert.deepEqual(q.offers, [], "the offers end with the archive");
  } finally { t.done(); }
});

test("text_anyway is refused on the estimate follow-up, and the sweep never texts a review-before-send step", async () => {
  const { t, owner } = await setup();
  try {
    const list = await t.api("/cadences", { as: owner });
    const est = list.body.data.find((c) => c.key === "estimate_followup");
    const got = await t.api(`/cadences/${est.id}`, { as: owner });
    const bad = await t.api(`/cadences/${est.id}`, { method: "PATCH", as: owner, ifMatch: got.headers.get("etag"), body: { unattended: "text_anyway" } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.field, "unattended");
    // a step's window passing with no call never texts it on its own
    const c = await makeLead(owner);
    // a sent quote (Quotes, M3a): the offer steps land on it, the archive step archives it
    const made = await t.api("/quotes", { method: "POST", as: owner, body: { contact_id: c.id, options: [{ name: "One-time", kind: "one_time", recommended: true, lines: [{ title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, category: "windows_ext" }] }] } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const QUOTE = made.body.data.id;
    assert.equal((await t.api(`/quotes/${QUOTE}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } })).status, 200);
    const id = await E.enroll(c.id, "estimate_followup", { quote_id: QUOTE }, { by: owner.id, origin: "api", actor_kind: "user", requestId: "x" });
    pin("2026-11-18T23:00:00Z");
    await AUTO.cadenceSweep({ budget: null, mode: { system_of_record: "rotor" }, mayAct: () => true, would: async () => {}, write: () => ({ by: "system:sales.cadence", origin: "worker", actor_kind: "automation", requestId: "s", mode: { system_of_record: "rotor" } }) });
    assert.equal(outbox(t).length, 0);
    assert.equal((await enrollment(id)).step_n, 1, "it waits (red on the list)");
  } finally { t.done(); }
});
