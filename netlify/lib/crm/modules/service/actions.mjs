// Service module: the job page's quick actions (guide-gaps S45b, SX12).
//
//   POST /jobs/:id/review-ask   a done job: the review ask text, once per job
//   POST /jobs/:id/tip-ask      a done job with an invoice: the invoice's link (its page takes a tip), once per job
//   POST /jobs/:id/callback     a done job: a no-charge touch-up job to book (the same place and work)
//
// Texts go through core/send.mjs like every other: in this test system they
// land in the Outbox (dry run), and a contact who said stop, or a
// customer Rotor still serves, is refused there, not here. "Text a pay
// link" is the invoice's own Send (POST /invoices/:id/send).

import { getRecord, getRecords } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { InputError, NotFoundError, ConflictError } from "../../core/errors.mjs";
import { sendMessage } from "../../core/send.mjs";
import { has, call } from "../../core/services.mjs";

export const TEMPLATES = [
  { key: "job_review_ask", name: "Review ask (from a job)", channel: "sms", category: "service", tags: ["review"],
    body: "Hi {{first_name|there}}, it's {{sender_first_name}} from Barta. Thanks for having us out! If you were happy with the work, a quick Google review helps our small team a ton.\n\n{{review_link}}" },
  { key: "job_tip_ask", name: "Tip ask (from a job)", channel: "sms", category: "service", tags: [],
    body: "Hi {{first_name|there}}, thanks again for having {{company_name}} out! Here's your invoice. If the crew did a great job, you can add a tip for them on the same page.\n\n{{invoice_link}}" },
];

const W = (ctx) => (typeof ctx.write === "function" ? ctx.write() : {});
async function doneJob(id) {
  if (!isId(id, "job")) throw new NotFoundError("That job isn't there.");
  const g = await getRecord("job", id);
  if (!g || g.data.deleted_at) throw new NotFoundError("That job isn't there.");
  if (g.data.status !== "completed") throw new ConflictError("Ask once the job is done.", { code: "not_done" });
  return g.data;
}
async function send(ctx, job, template_key, vars = {}) {
  const r = await sendMessage({
    contact_id: job.contact_id, channel: "sms", template_key, vars, related: { job_id: job.id }, origin: { kind: "user" }, category: "service",
    marker_key: `${template_key}--${job.id}`,
  }, { ...W(ctx), sysMode: await ctx.sysMode(), deploy: ctx.deploy });
  return { status: r.status, mode: r.mode || null, reason: r.reason || null, outbox_id: r.outbox_id || null };
}

export async function reviewAsk(ctx) {
  const job = await doneJob(ctx.params.id);
  return { status: 201, data: await send(ctx, job, "job_review_ask") };
}

export async function tipAsk(ctx) {
  const job = await doneJob(ctx.params.id);
  const invs = (await getRecords("invoice", (job.invoice_ids || []).slice(0, 10))).filter(Boolean).map((g) => g.data).filter((i) => !i.deleted_at && i.status !== "void");
  const inv = invs[0];
  if (!inv) throw new ConflictError("Make the job's invoice first.", { code: "no_invoice" });
  const { invoiceLink } = await import("../money/automations.mjs");
  const link = await invoiceLink(inv, ctx.user ? ctx.user.id : "system");
  return { status: 201, data: await send(ctx, job, "job_tip_ask", { invoice_link: link.url }) };
}

// A callback: a touch-up job (no charge) with the same place and work, waiting to be booked. Once per job.
export async function callback(ctx) {
  const job = await doneJob(ctx.params.id);
  if (!has("work.createJobs")) throw new ConflictError("Jobs aren't set up here yet.");
  const note = String((ctx.body || {}).note || "").trim().slice(0, 1000);
  const lines = (job.lines || []).slice(0, 10).map((l) => ({ title: String(l.title || "Touch-up").slice(0, 160), unit_cents: 0, qty_milli: l.qty_milli || 1000 }));
  if (!lines.length) lines.push({ title: "Touch-up", unit_cents: 0, qty_milli: 1000 });
  const [id] = await call("work.createJobs", [{
    contact_id: job.contact_id, ...(job.property_id ? { property_id: job.property_id } : {}), kind: "touch_up", title: `Callback: ${job.title || "job"}`.slice(0, 160), lines,
    office_notes: [`Callback for job ${job.number_label || job.number}.`, note].filter(Boolean).join("\n"),
  }], `job-callback--${job.id}`, "service.callback", W(ctx));
  if (!id) throw new InputError("That callback wasn't made.");
  return { status: 201, data: { job_id: id } };
}
