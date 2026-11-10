// M3a acceptance: the customer's approval (design §5.3, §8.5, §11.4
// "approve.test.mjs"): the portal approve answers 202 and a run; a double
// tap runs one op; a plan option creates the plan and a SIGNED agreement
// with the version's agreement hash through the (fake) plans service, then
// a Checkout setup URL; what the customer saw is what gets approved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sentQuote, oneTime, quarterly, portalCookie, approveBody, PJSON, quoteOf, runOf, finishRun, fakes, queued, scope, store, A, BYTES } from "./fixtures.mjs";

test("portal approve: 202 and a run; a double tap is one op; a plan option makes a signed plan with the version's agreement hash; then the card", async () => {
  const { t, owner } = await setup();
  const f = fakes();
  try {
    const { quote, version } = await sentQuote(t, owner, { agreement: { require_card: true } });
    const plan = version.options.find((o) => o.kind === "plan");
    assert.ok(version.plan_agreements[plan.id], "the plan option's agreement text is frozen with the version");
    const shown = version.plan_agreements[plan.id];
    const cookie = await portalCookie(t, quote);

    const page = await t.portal(`/p/quote/${quote.id}`, { cookie });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(`Plan agreement for the ${plan.name}`), "the agreement text is on the page, under the one signature");
    assert.match(page.text, /data-sig/);

    const body = approveBody(version, plan.id);
    const [a, b] = await Promise.all([
      t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body }),
      t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body }),
    ]);
    assert.equal(a.status, 202, JSON.stringify(a.body));
    assert.equal(b.status, 202, JSON.stringify(b.body));
    assert.equal(a.body.data.run_id, b.body.data.run_id, "a double tap is the same run");
    assert.equal(t.stores.data.keys("rec/run/").filter((k) => t.stores.data.json(k).kind === "quotes.approve").length, 1);

    const run = await finishRun(t, a.body.data.run_id);
    assert.equal(run.status, "done", JSON.stringify(run));
    assert.equal(run.result.status, "converted");
    assert.equal(run.result.checkout_url, "https://checkout.stripe.com/c/pay/cs_test_example", "card required: Checkout next");
    assert.equal(t.stores.data.keys("op/").filter((k) => k.startsWith("op/approve--")).length, 1, "one approve op");

    // the plan, signed, from the approved version, with the hash of the text shown
    assert.equal(f.calls.fromQuoteOption.length, 1);
    const call = f.calls.fromQuoteOption[0];
    assert.equal(call.version_id, version.id);
    assert.equal(call.option_id, plan.id);
    assert.equal(call.signature.body_sha256, shown.body_sha256, "the same signature signs the agreement that was shown");
    assert.equal(call.signature.version_sha256, version.sha256);
    assert.equal(call.signature.method, "portal");
    assert.ok(/^fl_/.test(call.signature.file_id));
    assert.deepEqual(call.lines, plan.lines.map((l) => l.id), "line ids kept");
    assert.equal(f.calls.deposit.length, 1);

    const q = await quoteOf(quote.id);
    assert.equal(q.status, "converted");
    assert.equal(q.approval.version_id, version.id);
    assert.equal(q.approval.version_sha256, version.sha256);
    assert.equal(q.approval.option_id, plan.id);
    assert.equal(q.approval.name_typed, "Pat Sample");
    assert.equal(q.converted_to.plan_id, "pl_00000000000000000001");
    assert.equal(q.converted_to.deposit_invoice_id, "in_00000000000000000001");
    const sig = t.stores.data.json(`rec/file/${q.approval.signature_id}`);
    assert.equal(sig.kind, "signature");
    assert.equal(sig.content_type, "image/png");
    assert.equal(sig.owner.id, quote.id);
    // events Sales and the timeline hear
    const names = queued(t).map((x) => x.data && x.data.name).filter(Boolean);
    assert.ok(names.includes("quote.approved") && names.includes("quote.converted"));

    // the run as the page sees it, and a replay after it finished: the same run
    const poll = await t.portal(`/api/portal/quotes/${quote.id}/runs/${a.body.data.run_id}`, { cookie });
    assert.equal(poll.body.data.status, "done");
    assert.equal(poll.body.data.result.checkout_url, "https://checkout.stripe.com/c/pay/cs_test_example");
    const replay = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body });
    assert.equal(replay.status, 202);
    assert.equal(replay.body.data.run_id, a.body.data.run_id);
    const done = await t.portal(`/p/quote/${quote.id}`, { cookie });
    assert.match(done.text, /You're all set, Pat!/);
    assert.doesNotMatch(done.text, /data-approve\b/, "no second approval form");
  } finally { f.restore(); t.done(); }
});

test("what the customer saw: a stale version → 409 updated; a wrong hash, no signature, no name or no 'I agree' → refused; nothing written", async () => {
  const { t, owner } = await setup();
  const f = fakes();
  try {
    const { quote, version } = await sentQuote(t, owner);
    const cookie = await portalCookie(t, quote);
    const one = version.options.find((o) => o.kind === "one_time");
    const post = (body) => t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body });
    assert.equal((await post(approveBody(version, one.id, { version_sha256: "0".repeat(64) }))).body.error.code, "updated");
    assert.equal((await post(approveBody(version, one.id, { signature_png_b64: Buffer.from(BYTES.jpeg()).toString("base64") }))).body.error.field, "signature_png_b64", "a PNG only");
    assert.equal((await post(approveBody(version, one.id, { signature_png_b64: "" }))).status, 400);
    assert.equal((await post(approveBody(version, one.id, { name_typed: " " }))).body.error.field, "name_typed");
    assert.equal((await post(approveBody(version, one.id, { agree: false }))).body.error.field, "agree");
    assert.equal((await post(approveBody(version, "op_nope"))).body.error.field, "option_id");
    assert.equal((await post(approveBody(version, one.id, { selected_line_ids: ["ln_nope"] }))).status, 400, "only this option's add-ons");
    const big = Buffer.concat([Buffer.from(BYTES.png()), Buffer.alloc(210 * 1024)]).toString("base64");
    assert.equal((await post(approveBody(version, one.id, { signature_png_b64: big }))).status, 400, "a signature over 200 KB");
    assert.equal(t.stores.data.keys("rec/run/").length, 0);
    assert.equal(t.stores.data.keys("rec/file/").length, 0);

    // staff edit and re-send: the old version is no longer current
    const cur = await t.api(`/quotes/${quote.id}`, { as: owner });
    const opts = cur.body.data.quote.options.map((o) => (o.kind === "one_time" ? { ...o, lines: [...o.lines, { title: "Screen Cleaning", qty_milli: 20000, unit_cents: 500, category: "screens", unit: "screen" }] } : o));
    const patched = await t.api(`/quotes/${quote.id}`, { method: "PATCH", as: owner, ifMatch: cur.headers.get("etag"), body: { options: opts } });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.status, "draft", "an edit after sending is a draft again");
    // until the re-send, the customer still sees (and may approve) what was sent
    const still = await t.portal(`/p/quote/${quote.id}`, { cookie });
    assert.ok(still.text.includes(version.id));
    await t.api(`/quotes/${quote.id}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    const stale = await post(approveBody(version, one.id));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "updated");
    assert.match(stale.body.error.message, /This quote was updated/);
  } finally { f.restore(); t.done(); }
});

test("an optional add-on the customer ticks is in the approval and the totals; one-time conversion waits for Scheduling when it isn't there", async () => {
  const { t, owner } = await setup();
  const f = fakes({ work: false });
  try {
    const opt = oneTime({ lines: [{ title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, category: "windows_ext" }, { title: "Screen Cleaning", qty_milli: 20000, unit_cents: 500, category: "screens", unit: "screen", optional: true }] });
    const { quote, version } = await sentQuote(t, owner, { options: [opt] });
    const cookie = await portalCookie(t, quote);
    const o = version.options[0];
    const addOn = o.lines.find((l) => l.optional);
    const r = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(version, o.id, { selected_line_ids: [addOn.id] }) });
    const run = await finishRun(t, r.body.data.run_id);
    assert.equal(run.result.status, "approved", "no Scheduling yet: approved, not converted (§11.3)");
    const q = await quoteOf(quote.id);
    assert.equal(q.status, "approved");
    assert.deepEqual(q.approval.selected_line_ids, [addOn.id]);
    assert.equal(q.approval.totals.first_cents, 39500, "$295 + 20 screens × $5");
    const view = await t.api(`/quotes/${quote.id}`, { as: owner });
    assert.equal(view.body.data.convertible, false);
    assert.equal((await t.api(`/quotes/${quote.id}/convert`, { method: "POST", as: owner, body: {} })).status, 409, "Convert is hidden until Scheduling");
    // Scheduling arrives: staff convert makes the job from the approved version, with the chosen add-on
    const w = fakes({ plans: false, money: false });
    try {
      const c = await t.api(`/quotes/${quote.id}/convert`, { method: "POST", as: owner, body: {} });
      assert.equal(c.status, 202, JSON.stringify(c.body));
      const cr = await finishRun(t, c.body.data.run_id);
      assert.equal(cr.status, "done", JSON.stringify(cr));
      assert.equal(w.calls.createJobs.length, 1);
      const job = w.calls.createJobs[0];
      assert.equal(job.scope, "quotes");
      assert.ok(job.opId.startsWith(`convert--${quote.id}--1`));
      assert.deepEqual(job.jobs[0].lines.map((l) => l.id), o.lines.map((l) => l.id), "the chosen add-on goes on the job, ids kept");
      assert.equal((await quoteOf(quote.id)).status, "converted");
      assert.deepEqual((await quoteOf(quote.id)).converted_to.job_ids, ["jb_00000000000000000001"]);
    } finally { w.restore(); }
  } finally { f.restore(); t.done(); }
});

test("approved by phone (staff): no signature, method phone, by the person; the plan's agreement then still needs one", async () => {
  const { t, owner, tech } = await setup();
  const f = fakes();
  try {
    const { quote, version } = await sentQuote(t, owner);
    const plan = version.options.find((o) => o.kind === "plan");
    assert.equal((await t.api(`/quotes/${quote.id}/approve`, { method: "POST", as: tech, body: { option_id: plan.id, by_phone: true } })).status, 403);
    assert.equal((await t.api(`/quotes/${quote.id}/approve`, { method: "POST", as: owner, body: { option_id: plan.id } })).status, 400);
    const r = await t.api(`/quotes/${quote.id}/approve`, { method: "POST", as: owner, body: { option_id: plan.id, by_phone: true } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const run = await finishRun(t, r.body.data.run_id);
    assert.equal(run.status, "done");
    const q = await quoteOf(quote.id);
    assert.equal(q.approval.method, "phone");
    assert.equal(q.approval.by, owner.id);
    assert.equal(q.approval.signature_id, undefined);
    assert.equal(f.calls.fromQuoteOption[0].signature, undefined, "no signature: the agreement stays to be signed");
  } finally { f.restore(); t.done(); }
});

test("an approval whose op fails for good says so; the version is never half-approved", async () => {
  const { t, owner } = await setup();
  const f = fakes();
  try {
    const { quote, version } = await sentQuote(t, owner);
    const cookie = await portalCookie(t, quote);
    const one = version.options.find((o) => o.kind === "one_time");
    const r = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(version, one.id) });
    // staff re-send a changed quote before the lane runs: the queued approval must not land on the new version
    await scope(() => store.updateRecord("quote", quote.id, (q) => ({ ...q, current_version_id: "qv_00000000000000000009" }), { by: owner.id, origin: "api", actor_kind: "user", requestId: "x" }));
    const run = await finishRun(t, r.body.data.run_id);
    assert.equal(run.status, "failed");
    assert.equal(run.error.code, "updated");
    const poll = await t.portal(`/api/portal/quotes/${quote.id}/runs/${r.body.data.run_id}`, { cookie });
    assert.equal(poll.body.data.code, "updated");
    const q = await quoteOf(quote.id);
    assert.notEqual(q.status, "approved");
    assert.equal(q.approval, undefined);
    assert.equal(A.approveOpId(quote.id, 1), `approve--${quote.id}--1`);
  } finally { f.restore(); t.done(); }
});

test("a crash between the approval's write and its event: the retried step sends quote.approved under the same event id", async () => {
  const { t, owner } = await setup();
  const f = fakes({ plans: false, work: false });
  try {
    const { quote, version } = await sentQuote(t, owner);
    const cookie = await portalCookie(t, quote);
    const one = version.options.find((o) => o.kind === "one_time");
    const r = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(version, one.id) });
    const input = (await runOf(r.body.data.run_id)).input;
    const { opKind } = await import("../../../netlify/lib/crm/core/ops.mjs");
    const record = () => scope(() => opKind("quotes.approve").steps(input)[0].run({ ctx: { by: "portal", origin: "portal", actor_kind: "portal", requestId: "crash" }, opId: A.approveOpId(quote.id, 1), out: {} }));
    const approvedItems = () => t.stores.data.keys("q/").filter((k) => { const x = t.stores.data.json(k); return x.data && x.data.name === "quote.approved"; });
    assert.deepEqual(await record(), { approved: true });
    const first = approvedItems();
    assert.ok(first.length >= 1, "the event is queued");
    const eventId = t.stores.data.json(first[0]).data.event_id;
    const q = await quoteOf(quote.id);
    assert.equal(q.status, "approved");
    assert.equal(q.approved_wv, q.wv, "the wv the approval was written at");
    // the crash: the write landed, the event never did
    for (const k of first) await t.stores.data.delete(k);
    assert.deepEqual(await record(), { already: true });
    const again = approvedItems();
    assert.ok(again.length >= 1, "the retry sends the event");
    assert.deepEqual([...new Set(again.map((k) => t.stores.data.json(k).data.event_id))], [eventId], "under the same event id");
    // another retry: items again, but under the same markers, so each listener still runs once (the queue's marker dedupe)
    const markers = (keys) => [...new Set(keys.map((k) => t.stores.data.json(k).marker.key))].sort();
    const before = markers(again);
    await record();
    assert.deepEqual(markers(approvedItems()), before);
    assert.equal((await quoteOf(quote.id)).wv, q.wv, "a retry writes nothing");
  } finally { f.restore(); t.done(); }
});
