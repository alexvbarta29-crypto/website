// Quotes module: approval and conversion (design §5.3, §3.6, §8.5).
//
// An approval is always a run (§2.2: "quote approve and convert (staff and
// portal)"): the request only checks what the customer saw and answers 202
// { run_id }; the fast lane runs the op approve--{quoteId}--{n} (n = the
// quote's approvals_count + 1 when the request arrived), so a double tap,
// a replayed request or a retried POST is the same op and the same run
// (the run id derives from the op id). A version that is no longer current
// gets 409 "This quote was updated" before anything is written.
//
// Tries: when the run of approval n FAILED (the office re-sent the quote
// between the tap and the run, or archived it), the next approval request
// is try 2: approve--{quoteId}--{n}--2, its own op and run (try 1 keeps the
// plain id). The try is the first one whose run is missing or didn't fail,
// so it stays deterministic: a double tap of try 2 is still one run.
// The convert op keeps convert--{quoteId}--{n} (one per approval).
//
//   approve op (quotes.approve)  record the approval on the quote (version id
//                                and hash, option, chosen optional lines, one
//                                signature file, how and by whom), emit
//                                quote.approved, tell the staff; then the
//                                deposit invoice / card Checkout when Money is
//                                there and the quote asks for one
//   convert op (quotes.convert)  from the APPROVED VERSION, never the live
//                                draft: a plan option → plans.fromQuoteOption
//                                (with the same signature, so the plan's
//                                agreement is created signed, §5.4); a one-time
//                                option → work.createJobs; then converted
//
// Conversion runs right after approval when cfg/pricing.auto_convert is on
// (default) and the service it needs exists (§11.3 feature gates: before
// Scheduling a one-time option stays approved and Convert is hidden; before
// Plans a plan option does).

import { createHash } from "node:crypto";
import { getRecord, updateRecord, settledWrite, getRaw } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { now, nowIso, localDate } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError, ExistsError } from "../../core/errors.mjs";
import { defineOp, runOp, opIdFor, readOp } from "../../core/ops.mjs";
import { defineRun, createRun } from "../../core/lanes.mjs";
import { storeImportedFile, sniffType } from "../../core/files.mjs";
import { has, call } from "../../core/services.mjs";
import { notify, approvers } from "../../core/notify.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { getQuote, emitQuote, touchStats, timeline, W, loadPricing, customerCanAnswer, versionClosed } from "./quotes.mjs";
import { getVersion } from "./versions.mjs";
import { optionTotals } from "./pricing.mjs";

export const MAX_SIGNATURE_BYTES = 200 * 1024;
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const approvable = customerCanAnswer;
export const MAX_TRIES = 20;

export const approveOpId = (quoteId, n, attempt = 1) => `${opIdFor(`approve--${quoteId}`, n)}${Number.isSafeInteger(attempt) && attempt > 1 ? `--${attempt}` : ""}`;
export const convertOpId = (quoteId, n) => opIdFor(`convert--${quoteId}`, n);
export const approveRunId = (quoteId, n, attempt = 1) => deriveId("run", approveOpId(quoteId, n, attempt), "quotes.approve", 0);
export const convertRunId = (quoteId, n) => deriveId("run", convertOpId(quoteId, n), "quotes.convert", 0);

// The option as the customer chose it: optional lines on only when picked; totals again.
export function chosenOption(option, selectedLineIds = [], pricing) {
  const pick = new Set(selectedLineIds || []);
  const lines = (option.lines || []).map((l) => (l.optional ? { ...l, selected: pick.has(l.id) } : l));
  const o = { ...option, lines };
  return { ...o, totals: optionTotals(o, pricing) };
}

// Can this option become a plan or jobs now (§11.3 feature gates)?
export const canConvert = (option) => !!option && (option.kind === "plan" ? has("plans.fromQuoteOption") : has("work.createJobs"));

// A PNG data string → bytes (≤ 200 KB, really a PNG).
export function signatureBytes(b64) {
  const s = String(b64 || "").replace(/^data:image\/png;base64,/, "");
  if (!s || !/^[A-Za-z0-9+/=\s]+$/.test(s)) throw new InputError("Sign in the box first.", "signature_png_b64");
  const bytes = new Uint8Array(Buffer.from(s, "base64"));
  if (bytes.length > MAX_SIGNATURE_BYTES) throw new InputError("That signature is too big. Clear it and sign again.", "signature_png_b64");
  if (bytes.length < 60 || sniffType(bytes) !== "image/png") throw new InputError("Sign in the box first.", "signature_png_b64");
  return bytes;
}

// ------------------------------------------------------------ starting an approval (request side)

// who: { method: "portal" | "in_person" | "phone", by, ip_hash?, ua?, link_key? }
// body: { version_id, version_sha256?, option_id, selected_line_ids?, name_typed?, signature_png_b64?, agree? }
// → { run_id, already?: true }
export async function startApproval(quoteId, body = {}, who = {}, ctx = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("That isn't an approval.", "body");
  if (typeof body.version_id !== "string" || !body.version_id) throw new InputError("Which version? Reload the page.", "version_id");
  const { data: q } = await getQuote(quoteId);
  if (who.contact_id && q.contact_id !== who.contact_id) throw new NotFoundError("That quote isn't here.");
  const n0 = q.approvals_count || 0;
  // a replay after the approval finished: the same run
  if (["approved", "converted"].includes(q.status) && q.approval && q.approval.version_id === body.version_id && q.approval.option_id === body.option_id && n0 > 0) {
    return { run_id: approveRunId(q.id, n0, q.approval.attempt || 1), already: true };
  }
  if (!approvable(q)) {
    if (q.status === "approved" || q.status === "converted") throw new ConflictError("This quote is already approved.", { code: "approved" });
    throw new ConflictError(q.status === "archived" ? "This quote has expired. Call or text us for a fresh one." : "This quote can't be approved right now. Call or text us.", { code: "not_open" });
  }
  if (!body.version_id || body.version_id !== q.current_version_id) throw updated();
  const version = await getVersion(q.current_version_id);
  if (!version) throw updated();
  if (who.method !== "phone" && body.version_sha256 !== version.sha256) throw updated();
  const closed = versionClosed(q, version, { today: localDate(now()), pricing: await loadPricing() });
  if (closed) throw new ConflictError(who.method === "phone" ? closed.staff : closed.message, { code: closed.code });
  const option = (version.options || []).find((o) => o.id === body.option_id);
  if (!option) throw new InputError("Pick one of the options.", "option_id");
  const optionalIds = new Set((option.lines || []).filter((l) => l.optional).map((l) => l.id));
  // no list sent (an older client): the add-ons as the version had them ticked
  const chosen = [...new Set(Array.isArray(body.selected_line_ids) ? body.selected_line_ids.map(String) : (option.lines || []).filter((l) => l.optional && l.selected === true).map((l) => l.id))];
  if (chosen.some((id) => !optionalIds.has(id))) throw new InputError("That add-on isn't on this option.", "selected_line_ids");
  let name = String(body.name_typed ?? "").trim();
  let bytes = null;
  if (who.method !== "phone") {
    if (name.length < 2) throw new InputError("Type your full name.", "name_typed");
    if (name.length > 120) throw new InputError("That name is too long.", "name_typed");
    if (body.agree !== true) throw new InputError("Check the box to agree to the terms.", "agree");
    bytes = signatureBytes(body.signature_png_b64);
  } else name = name.slice(0, 120);
  const n = n0 + 1;
  // the first try whose run is missing (start it) or didn't fail (a double tap: the same run)
  let attempt = 1;
  for (;; attempt++) {
    if (attempt > MAX_TRIES) throw new ConflictError("This quote can't be approved online right now. Call or text us.", { code: "not_open" });
    const had = await getRecord("run", approveRunId(q.id, n, attempt)).catch(() => null);
    if (!had) break;
    if (had.data.status !== "failed") return { run_id: had.data.id, already: true };
  }
  const opId = approveOpId(q.id, n, attempt);
  const runId = approveRunId(q.id, n, attempt);
  let signature_id;
  if (bytes) {
    signature_id = deriveId("file", opId, "signature", 1);
    const had = await getRecord("file", signature_id).catch(() => null);
    if (!had) {
      try {
        await storeImportedFile({ bytes, owner: { type: "quote", id: q.id }, kind: "signature", contactId: q.contact_id, source: who.method === "in_person" ? "present" : "portal", id: signature_id }, W(ctx));
      } catch (e) {
        if (!(e instanceof ExistsError) && !(await getRecord("file", signature_id).catch(() => null))) throw e;
      }
    }
  }
  const input = {
    quote_id: q.id, n, ...(attempt > 1 ? { attempt } : {}), version_id: version.id, version_sha256: version.sha256, option_id: option.id, selected_line_ids: chosen,
    name_typed: name, signature_id, method: who.method, by: who.by || null, ip_hash: who.ip_hash || null, ua: who.ua || null, at: nowIso(),
    ...(who.link_key ? { link_key: who.link_key } : {}),
  };
  const actor = { by: who.actor_by || (who.method === "phone" ? who.by : "portal"), origin: who.method === "phone" ? "api" : "portal", actor_kind: who.method === "phone" ? "user" : "portal", requestId: (W(ctx).requestId) || "approve" };
  await createRun("quotes.approve", input, actor, { id: runId });
  return { run_id: runId };
}

const updated = () => new ConflictError("This quote was updated. Take a look at the new version.", { code: "updated" });

// ------------------------------------------------------------ the ops

defineOp("quotes.approve", {
  lane: "fast",
  steps(input) {
    return [
      {
        name: "record",
        async run(s) {
          const g = await getRecord("quote", input.quote_id);
          if (!g) throw new NotFoundError("That quote isn't there.");
          const q0 = g.data;
          if (q0.approval && q0.approval.version_id === input.version_id && (q0.approvals_count || 0) >= input.n) {
            // a retry after a crash between the write and what follows it: the event goes out under the same id (id:wv), the rest again
            if ((q0.approvals_count || 0) === input.n && Number.isSafeInteger(q0.approved_wv)) await approvedEffects({ ...q0, wv: q0.approved_wv }, input, s.ctx);
            return { already: true };
          }
          if (!approvable(q0)) throw new ConflictError("This quote can't be approved now.", { code: "not_open" });
          if (q0.current_version_id !== input.version_id) throw updated();
          const version = await getVersion(input.version_id);
          const option = version && (version.options || []).find((o) => o.id === input.option_id);
          if (!option) throw new ConflictError("That option isn't on the quote.");
          const closed = versionClosed(q0, version, { today: localDate(now()), pricing: await loadPricing() });
          if (closed) throw new ConflictError(closed.message, { code: closed.code });
          const at = input.at || nowIso();
          const approval = {
            version_id: input.version_id, version_sha256: input.version_sha256, option_id: input.option_id, selected_line_ids: input.selected_line_ids || [],
            ...(input.signature_id ? { signature_id: input.signature_id } : {}), name_typed: input.name_typed || "", ip_hash: input.ip_hash || undefined, ua: input.ua || undefined,
            at, method: input.method, ...(input.by ? { by: input.by } : {}), totals: chosenOption(option, input.selected_line_ids, await loadPricing()).totals,
            ...(input.attempt > 1 ? { attempt: input.attempt } : {}),
          };
          const r = await updateRecord("quote", input.quote_id, (q) => {
            if (q.approval && q.approval.version_id === input.version_id && (q.approvals_count || 0) >= input.n) return null;
            if (!approvable(q) || q.current_version_id !== input.version_id) throw updated();
            return { ...q, status: "approved", approved_at: at, approval, selected_option_id: input.option_id, approvals_count: input.n, approved_wv: (q.wv || 0) + 1 };
          }, s.ctx);
          if (r.changed) await approvedEffects(r.data, input, s.ctx);
          return { approved: true };
        },
      },
      {
        name: "deposit",
        async run(s) {
          const g = await getRecord("quote", input.quote_id);
          const q = g && g.data;
          if (!q || !q.approval) return { skipped: true };
          const ag = (q.agreement || {});
          const wants = ag.require_card === true || (ag.deposit && ag.deposit.type && ag.deposit.type !== "none" && ag.deposit.value > 0);
          if (!wants || !has("money.createDepositInvoice")) return { skipped: true };
          const version = await getVersion(q.approval.version_id);
          const pricing = await loadPricing();
          const option = chosenOption((version.options || []).find((o) => o.id === q.approval.option_id), q.approval.selected_line_ids, pricing);
          const out = (await call("money.createDepositInvoice", q, version, option, s.opId, s.ctx)) || {};
          if (out.invoice_id) await updateRecord("quote", q.id, (x) => ({ ...x, converted_to: { job_ids: [], ...(x.converted_to || {}), deposit_invoice_id: out.invoice_id } }), s.ctx);
          return { invoice_id: out.invoice_id || null, checkout_url: typeof out.checkout_url === "string" ? out.checkout_url : null };
        },
      },
    ];
  },
});

// What follows an approval: the event (Sales, Plans), the contact's stats and timeline, the people to tell.
async function approvedEffects(q, input, ctx) {
  const version = await getVersion(input.version_id);
  const option = version && (version.options || []).find((o) => o.id === input.option_id);
  await Promise.all([
    emitQuote("quote.approved", q, { option_id: input.option_id, method: input.method }, ctx),
    touchStats(q, ctx),
    timeline(q, "quote.approved"),
    option ? tellStaff(q, option, input.method, ctx) : null,
  ]);
}

async function tellStaff(q, option, method, ctx) {
  try {
    const people = new Set(await approvers().catch(() => []));
    if (isId(q.sold_by, "user")) people.add(q.sold_by);
    const first = String(q.contact_name || "").split(/\s+/)[0] || "A customer";
    const how = method === "in_person" ? " in person" : method === "phone" ? " by phone" : "";
    await notify([...people].slice(0, 10), { kind: "quote_approved", title: `${first} approved${how}`, body: `${option.name} on quote ${q.number_label}.`, link: `/quotes/${q.id}` }, W(ctx));
  } catch (e) {
    console.error(`crm:quotes: approval notification not sent (${safeErr(e)})`);
  }
}

defineOp("quotes.convert", {
  lane: "fast",
  steps(input) {
    return [
      {
        name: "make",
        async run(s) {
          const g = await getRecord("quote", input.quote_id);
          if (!g) throw new NotFoundError("That quote isn't there.");
          const q = g.data;
          if (q.status === "converted") return { already: true, ...(q.converted_to || {}) };
          if (q.status !== "approved" || !q.approval) throw new ConflictError("Only an approved quote can be converted.");
          const version = await getVersion(q.approval.version_id);
          if (!version) throw new NotFoundError("The approved version isn't there.");
          const pricing = await loadPricing();
          const option = chosenOption((version.options || []).find((o) => o.id === q.approval.option_id), q.approval.selected_line_ids, pricing);
          if (!canConvert(option)) throw new ConflictError(option.kind === "plan" ? "Turning a plan option into a plan arrives with Plans." : "Turning a quote into jobs arrives with Scheduling.", { code: "not_available" });
          if (option.kind === "plan") {
            const ag = version.plan_agreements && version.plan_agreements[option.id];
            const signature = q.approval.signature_id ? {
              file_id: q.approval.signature_id, name_typed: q.approval.name_typed, method: q.approval.method, by: q.approval.by || null, ip_hash: q.approval.ip_hash || null,
              ua: q.approval.ua || null, at: q.approval.at, version_id: version.id, version_sha256: version.sha256, ...(ag ? { body_sha256: ag.body_sha256, template_id: ag.template_id, template_version: ag.template_version } : {}),
            } : undefined;
            const out = (await call("plans.fromQuoteOption", q, version, option, s.opId, { ...(signature ? { signature } : {}) }, s.ctx)) || {};
            return { plan_id: out.plan_id || null, agreement_id: out.agreement_id || null, job_ids: Array.isArray(out.job_ids) ? out.job_ids : [] };
          }
          const job = {
            contact_id: q.contact_id, property_id: q.property_id || null, kind: option.lines.some((l) => l.category === "lights") ? "lights_install" : "standard",
            title: `${option.name} (${q.number_label})`.slice(0, 120), lines: option.lines.filter((l) => !l.optional || l.selected), discounts: option.discounts || [],
            quote_id: q.id, deal_id: q.deal_id || null, billable: true,
          };
          const ids = (await call("work.createJobs", [job], s.opId, "quotes", s.ctx)) || [];
          return { job_ids: Array.isArray(ids) ? ids : [] };
        },
      },
      {
        name: "finish",
        async run(s) {
          const made = s.out.make || {};
          const r = await updateRecord("quote", input.quote_id, (q) => {
            if (q.status === "converted") return null;
            const converted_to = { ...(q.converted_to || {}), job_ids: made.job_ids || [], ...(made.plan_id ? { plan_id: made.plan_id } : {}), ...(made.agreement_id ? { agreement_id: made.agreement_id } : {}) };
            return { ...q, status: "converted", converted_at: nowIso(), converted_to, converted_wv: (q.wv || 0) + 1 };
          }, s.ctx);
          // a retry after a crash right after the write replays the event under the same id (id:converted_wv)
          const q = r.changed || !Number.isSafeInteger(r.data.converted_wv) ? r.data : { ...r.data, wv: r.data.converted_wv };
          if (r.changed || q.wv === r.data.converted_wv) {
            await Promise.all([
              emitQuote("quote.converted", q, { option_id: q.approval && q.approval.option_id, ...(q.converted_to.plan_id ? { plan_id: q.converted_to.plan_id } : {}), job_ids: q.converted_to.job_ids || [] }, s.ctx),
              touchStats(q, s.ctx),
              timeline(q, "quote.converted"),
            ]);
          }
          return { status: "converted", ...(q.converted_to || {}) };
        },
      },
    ];
  },
});

// ------------------------------------------------------------ the runs

// The person's write context the op runs under (a portal approval and a
// person's convert keep the exemption people have from the guard, §3.10).
function personCtx(run, rctx) {
  const i = run.input || {};
  const portal = i.method === "portal" || i.method === "in_person";
  return {
    by: portal ? (i.method === "in_person" && isId(i.by, "user") ? i.by : "portal") : (run.requested_by || "system"),
    origin: portal ? "portal" : "api", actor_kind: portal ? "portal" : (isId(run.requested_by, "user") ? "user" : "automation"),
    requestId: rctx.holder || "quotes", ...(rctx.mode ? { mode: rctx.mode } : {}),
  };
}

// A single-use present link is used up once its approval went through.
async function useUpLink(linkKey) {
  if (typeof linkKey !== "string" || !/^plk\/[0-9a-f]{64}$/.test(linkKey)) return;
  const got = await getRaw(linkKey).catch(() => null);
  if (!got || !got.data || got.data.used_up_at) return;
  await settledWrite(linkKey, { ...got.data, used_up_at: nowIso() }, { onlyIfMatch: got.etag }).catch(() => {});
}

async function finishOrThrow(opId, kind, input, ctx, holder) {
  let out;
  try {
    out = await runOp(opId, kind, { input, ctx, holder });
  } catch (e) {
    const j = await readOp(opId).catch(() => null);
    if (!j || j.status !== "failed") throw e;
    out = { status: "failed", error: j.error || null };
  }
  return out;
}

async function approveStep(run, rctx) {
  const i = run.input || {};
  const ctx = personCtx(run, rctx);
  const opId = approveOpId(i.quote_id, i.n, i.attempt || 1);
  const a = await finishOrThrow(opId, "quotes.approve", i, ctx, `approve.${run.id}`);
  if (a.status === "failed") return { failed: (a.error && a.error.code) || "failed", result: { status: "failed", message: (a.error && a.error.message) || null } };
  if (a.status !== "done") return { progress: { done: 0, total: 2 } };
  const op = await readOp(opId).catch(() => null);
  const dep = (op && op.out && op.out.deposit) || {};
  const result = { status: "approved", quote_id: i.quote_id, ...(dep.checkout_url ? { checkout_url: dep.checkout_url } : {}), ...(dep.invoice_id ? { invoice_id: dep.invoice_id } : {}) };
  const pricing = await loadPricing();
  const g = await getRecord("quote", i.quote_id);
  const q = g && g.data;
  if (q && pricing.auto_convert !== false && q.status === "approved") {
    const version = await getVersion(q.approval.version_id);
    const option = version && (version.options || []).find((o) => o.id === q.approval.option_id);
    if (canConvert(option)) {
      const c = await finishOrThrow(convertOpId(i.quote_id, i.n), "quotes.convert", { quote_id: i.quote_id, n: i.n }, ctx, `convert.${run.id}`);
      if (c.status === "running") return { progress: { done: 1, total: 2 } };
      if (c.status === "done") Object.assign(result, { status: "converted", ...(c.result || {}) });
      else result.convert_failed = (c.error && c.error.code) || "failed";
    }
  }
  if (i.link_key) await useUpLink(i.link_key);
  return { done: true, result, progress: { done: 2, total: 2 } };
}
defineRun("quotes.approve", { lane: "fast", step: approveStep, label: "Approve a quote" });

async function convertStep(run, rctx) {
  const i = run.input || {};
  const c = await finishOrThrow(convertOpId(i.quote_id, i.n), "quotes.convert", { quote_id: i.quote_id, n: i.n }, personCtx(run, rctx), `convert.${run.id}`);
  if (c.status === "failed") return { failed: (c.error && c.error.code) || "failed", result: { status: "failed", message: (c.error && c.error.message) || null } };
  if (c.status !== "done") return { progress: { done: 0, total: 1 } };
  return { done: true, result: { status: "converted", quote_id: i.quote_id, ...(c.result || {}) }, progress: { done: 1, total: 1 } };
}
defineRun("quotes.convert", { lane: "fast", step: convertStep, label: "Convert a quote" });

// POST /quotes/:id/convert: staff, for an approved quote (auto-convert off,
// or the service it needs arrived after the approval).
export async function startConvert(quoteId, ctx) {
  const { data: q } = await getQuote(quoteId);
  if (q.status === "converted") throw new ConflictError("This quote is already converted.");
  if (q.status !== "approved" || !q.approval) throw new ConflictError("Only an approved quote can be converted.");
  const version = await getVersion(q.approval.version_id);
  const option = version && (version.options || []).find((o) => o.id === q.approval.option_id);
  if (!canConvert(option)) throw new ConflictError(option && option.kind === "plan" ? "Turning a plan option into a plan arrives with Plans." : "Turning a quote into jobs arrives with Scheduling.", { code: "not_available" });
  const n = q.approvals_count || 1;
  return createRun("quotes.convert", { quote_id: q.id, n }, W(ctx), { id: convertRunId(q.id, n) });
}

// What the portal may see of an approval run.
export function runForPortal(run) {
  const r = run.result || {};
  return {
    status: run.status, code: run.status === "failed" ? String((run.error && run.error.code) || "failed").slice(0, 40) : null,
    result: run.status === "done" || run.status === "failed"
      ? { status: r.status || (run.status === "failed" ? "failed" : "approved"), ...(typeof r.checkout_url === "string" && /^(https:\/\/checkout\.stripe\.com\/|\/p\/dry-checkout\/)/.test(r.checkout_url) ? { checkout_url: r.checkout_url } : {}), ...(r.message ? { message: String(r.message).slice(0, 200) } : {}) }
      : null,
  };
}

export { sha };
