// MCP module (M7c): the mcp module's own tools (design §6.9 catalog).
// Every other module adds its tools in its manifest's mcpTools; server.mjs
// gathers them all. Tool shape:
//
//   { name, description, inputSchema, effect: "read" | "write" | "contact" | "money", perm,
//     scoped?   (the perm may be a tech's "own": the route behind it scopes by record),
//     run?(args, ctx)          a read: the answer
//     preview?(args, ctx)      a change: what the owner sees ({ title, rendered_text, recipients? })
//     exec?(args, ctx, action) a change: what runs once an owner approves (ctx is the approver's)
//     confirm?: true           a staff-side destructive tool: a confirm token first (§6.9) }
//
// Reads go through the CRM's own routes (invoke.mjs callRoute) with the
// key's user and scopes, so a tool sees what that person sees on screen.
// Changes are pending actions only (actions.mjs): nothing moves until an
// owner taps Approve.

import { getRecord, readIndex } from "../../../crm-store.mjs";
import { isId, typeOf } from "../../core/ids.mjs";
import { now, localDate, addLocalDays } from "../../core/clock.mjs";
import { InputError, NotFoundError, ForbiddenError } from "../../core/errors.mjs";
import { CANONICAL_ORIGIN } from "../../core/context.mjs";
import { callRoute } from "./invoke.mjs";
import { pendingStatus } from "./actions.mjs";
import { reportInvoices, reportPayments, reportJobs, reportVisits, reportServicePlans, GROUPS } from "./reports.mjs";

const S = (props, required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}), additionalProperties: false });
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const int = (description, extra = {}) => ({ type: "integer", description, ...extra });
const ID = (type) => str(`A ${type} id (from a list or search)`);
const DATE = (what) => str(`${what} (YYYY-MM-DD, Central time)`);
const REPORT_INPUT = S({ start: DATE("First day"), end: DATE("Last day"), group_by: str("day, week, month (default) or none", { enum: [...GROUPS] }), date_field: str("Which date counts (see the description)") });
const appLink = (path) => `${CANONICAL_ORIGIN}/crm#${path}`;
const take = (rows, n = 100) => (Array.isArray(rows) ? rows.slice(0, n) : rows);

async function get(ctx, path, query) { return (await callRoute(ctx, "GET", path, { query })).data; }

// A contact the key's person may see, for a change's preview.
async function contactFor(ctx, id) {
  if (!isId(id, "contact")) throw new InputError("Pass a contact id (search_contacts finds one).", "contact_id");
  const got = await getRecord("contact", id);
  const c = got && got.data;
  if (!c || c.deleted_at || c.merged_into) throw new NotFoundError("That contact isn't there.");
  if (!ctx.can("contacts:read_all")) throw new ForbiddenError("This key doesn't have access to that contact.");
  return c;
}
const nameOf = (c) => c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.company_name || "No name";
const phoneOf = (c) => { const p = (c.phones || []).find((x) => x.primary) || (c.phones || [])[0]; return p ? p.e164 : null; };
const emailOf = (c) => { const e = (c.emails || []).find((x) => x.primary) || (c.emails || [])[0]; return e ? e.address : null; };
const clientIdOf = (action) => `mcp-${String(action.id).slice(3)}`;
const contactRow = (r) => ({ id: r.id, name: r.n, first_name: r.f, last_name: r.l, company: r.co || undefined, phones: r.p, emails: r.e, address: r.a, town: r.c, zip: r.z, lifecycle: r.lc, source: r.src, tags: r.tg });

export const tools = [
  // ------------------------------------------------------------ contacts
  {
    name: "search_contacts", effect: "read", perm: "contacts:read_all",
    description: "Find customers and leads by name, phone, email, street or town. Returns up to `limit` (default 25, at most 100) with ids for the other tools; pass `cursor` from the last answer for more.",
    inputSchema: S({ q: str("Words to look for"), lifecycle: str("lead, customer, former_customer or archived"), town: str("A town, like Delano"), limit: int("At most 100"), cursor: str("From the last answer's next_cursor") }),
    run: async (a, ctx) => {
      const limit = Math.min(100, Math.max(1, Number(a.limit) || 25));
      const r = await callRoute(ctx, "GET", "/contacts", { query: { q: a.q, lifecycle: a.lifecycle, town: a.town, limit, cursor: a.cursor } });
      const rows = Array.isArray(r.data) ? r.data : (r.data && r.data.rows) || [];
      const offset = Number(a.cursor) || 0;
      const total = r.meta && Number.isFinite(r.meta.total) ? r.meta.total : null;
      return { contacts: rows.slice(0, limit).map((x) => (x && x.n !== undefined ? contactRow(x) : x)), total, next_cursor: total !== null && offset + limit < total ? String(offset + limit) : null };
    },
  },
  {
    name: "get_contact", effect: "read", perm: "contacts:read", scoped: true,
    description: "One customer or lead: names, phones, emails, address, lifecycle, source, consent, tags and notes, with its properties.",
    inputSchema: S({ contact_id: ID("contact") }, ["contact_id"]),
    run: async (a, ctx) => {
      if (!isId(a.contact_id, "contact")) throw new InputError("Pass a contact id.", "contact_id");
      const d = await get(ctx, `/contacts/${a.contact_id}`);
      return { ...d, link: appLink(`/contacts/${a.contact_id}`) };
    },
  },
  {
    name: "list_activity", effect: "read", perm: "contacts:read", scoped: true,
    description: "A contact's timeline (calls, texts, quotes, visits, payments, notes), newest first.",
    inputSchema: S({ contact_id: ID("contact") }, ["contact_id"]),
    run: async (a, ctx) => {
      if (!isId(a.contact_id, "contact")) throw new InputError("Pass a contact id.", "contact_id");
      return { activity: take(await get(ctx, `/contacts/${a.contact_id}/activity`), 60) };
    },
  },
  // ------------------------------------------------------------ sales
  {
    name: "list_deals", effect: "read", perm: "sales:work",
    description: "Open deals (the pipeline): contact, title, status (open, quoted) and value in cents. Or one contact's deals.",
    inputSchema: S({ status: str("open or quoted"), contact_id: ID("contact") }),
    run: async (a, ctx) => ({ deals: take(await get(ctx, "/deals", { status: a.status, contact: a.contact_id })) }),
  },
  {
    name: "list_tasks", effect: "read", perm: "tasks:read",
    description: "Open tasks (to-dos, follow-ups, estimate visits), with due time, contact and who has them.",
    inputSchema: S({ status: str("open, in_progress, waiting or done"), assignee: ID("user"), contact_id: ID("contact"), kind: str("todo, follow_up, call, estimate_visit, meeting...") }),
    run: async (a, ctx) => ({ tasks: take(await get(ctx, "/tasks", { status: a.status, assignee: a.assignee, contact: a.contact_id, kind: a.kind })) }),
  },
  // ------------------------------------------------------------ work
  {
    name: "get_schedule", effect: "read", perm: "schedule:read",
    description: "The schedule between two dates (at most 6 weeks): each visit's date, time, arrival window, customer, town, services, crew and status, plus time off.",
    inputSchema: S({ from: DATE("First day (default today)"), to: DATE("Last day (default the first day)") }),
    run: async (a, ctx) => {
      const d = await get(ctx, "/schedule", { from: a.from, to: a.to });
      return { from: d.from, to: d.to, today: d.today, visits: take(d.visits, 200), time_off: d.time_off || [], tasks: d.sales || undefined };
    },
  },
  {
    name: "get_visit", effect: "read", perm: "schedule:read", scoped: true,
    description: "One visit: when, who, status, checklist and the job it belongs to.",
    inputSchema: S({ visit_id: ID("visit") }, ["visit_id"]),
    run: async (a, ctx) => {
      if (!isId(a.visit_id, "visit")) throw new InputError("Pass a visit id.", "visit_id");
      return get(ctx, `/visits/${a.visit_id}`);
    },
  },
  {
    name: "list_jobs", effect: "read", perm: "schedule:read",
    description: "Jobs: open ones by default (unscheduled, scheduled, in progress), or done / cancelled ones of a year, or one contact's.",
    inputSchema: S({ status: str("open (default), stale, done, cancelled or all"), year: str("For done or cancelled: a year like 2026"), contact_id: ID("contact") }),
    run: async (a, ctx) => ({ jobs: take(await get(ctx, "/jobs", { status: a.status, year: a.year, contact: a.contact_id }), 150) }),
  },
  {
    name: "get_job", effect: "read", perm: "schedule:read", scoped: true,
    description: "One job: lines, totals (cents), status, its visits and notes.",
    inputSchema: S({ job_id: ID("job") }, ["job_id"]),
    run: async (a, ctx) => {
      if (!isId(a.job_id, "job")) throw new InputError("Pass a job id.", "job_id");
      return { ...(await get(ctx, `/jobs/${a.job_id}`)), link: appLink(`/jobs/${a.job_id}`) };
    },
  },
  {
    name: "list_stale", effect: "read", perm: "schedule:read",
    description: "Visits whose day has passed but nobody finished, cancelled or marked no-access.",
    inputSchema: S({}),
    run: async (a, ctx) => ({ stale: take(await get(ctx, "/stale")) }),
  },
  {
    name: "list_team", effect: "read", perm: "schedule:read",
    description: "The team: each person's id, name, role and whether they are a technician (for assigning tasks and visits).",
    inputSchema: S({}),
    run: async () => {
      const ix = await readIndex("users", "");
      return { team: ix.rows.filter((u) => u.status === "active").map((u) => ({ id: u.id, name: u.name, first_name: u.first_name || null, role: u.role, technician: !!u.is_technician })) };
    },
  },
  // ------------------------------------------------------------ money and reports
  {
    name: "money_summary", effect: "read", perm: "invoices:read_all",
    description: "What is owed and overdue right now, and this month's collections (cents).",
    inputSchema: S({}),
    run: async (a, ctx) => get(ctx, "/money/summary"),
  },
  {
    name: "report_invoices", effect: "read", perm: "reports:read",
    description: "Rotor-compatible: invoices billed between start and end (date_field issued, the default, or created), totals and buckets by day, week or month: billed, paid and still-owed cents. \"What did we bill last month\" is this tool with last month's first and last day.",
    inputSchema: REPORT_INPUT, run: (a) => reportInvoices(a),
  },
  {
    name: "report_payments", effect: "read", perm: "reports:read",
    description: "Rotor-compatible: money collected between start and end (succeeded payments by received date; refunds and tips apart; test payments left out), in cents.",
    inputSchema: REPORT_INPUT, run: (a) => reportPayments(a),
  },
  {
    name: "report_jobs", effect: "read", perm: "reports:read",
    description: "Rotor-compatible: jobs completed between start and end (date_field completed, the default, or scheduled for their first visit), count and value in cents.",
    inputSchema: REPORT_INPUT, run: (a) => reportJobs(a),
  },
  {
    name: "report_visits", effect: "read", perm: "reports:read",
    description: "Rotor-compatible: visits between start and end, counted by status.",
    inputSchema: REPORT_INPUT, run: (a) => reportVisits(a),
  },
  {
    name: "report_service_plans", effect: "read", perm: "reports:read",
    description: "Rotor-compatible: care and lights plans made between start and end, by status, with their sale value in cents, and how many are active now.",
    inputSchema: REPORT_INPUT, run: (a) => reportServicePlans(a),
  },
  // ------------------------------------------------------------ generic
  {
    name: "search", effect: "read", perm: "contacts:read_all",
    description: "Search the CRM (names, phones, streets, quote and invoice numbers). Returns results with ids for fetch.",
    inputSchema: S({ query: str("What to look for") }, ["query"]),
    run: async (a, ctx) => {
      const d = (await get(ctx, "/search", { q: String(a.query || "").slice(0, 100) })) || {};
      const PATHS = { contact: "contacts", quote: "quotes", job: "jobs", invoice: "invoices", plan: "plans", visit: "visits" };
      const url = (type, id) => (PATHS[type] ? appLink(`/${PATHS[type]}/${id}`) : undefined);
      return {
        results: [
          ...(d.numbers || []).map((n) => ({ id: n.id, title: n.label, kind: n.type, url: url(n.type, n.id) })),
          ...(d.contacts || []).map((c) => ({ id: c.id, title: c.name, kind: "contact", sub: c.sub || undefined, url: url("contact", c.id) })),
        ].slice(0, 20),
      };
    },
  },
  {
    name: "fetch", effect: "read", perm: "contacts:read_all",
    description: "Open one record by its id (a contact, quote, job, visit, invoice or plan id from search or a list).",
    inputSchema: S({ id: str("The record id") }, ["id"]),
    run: async (a, ctx) => {
      const id = String(a.id || "");
      const type = typeOf(id);
      const paths = { contact: "contacts", quote: "quotes", job: "jobs", visit: "visits", invoice: "invoices", plan: "plans" };
      if (!type || !paths[type] || !isId(id, type)) throw new InputError("Pass a contact, quote, job, visit, invoice or plan id.", "id");
      const data = await get(ctx, `/${paths[type]}/${id}`);
      return { id, type, url: appLink(`/${paths[type]}/${id}`), data };
    },
  },
  {
    name: "get_pending_action", effect: "read", perm: null,
    description: "Whether an owner approved one of your requests yet (pending, approved, rejected, expired, done or failed), and what it made.",
    inputSchema: S({ pending_action_id: str("The pa_… id a request gave you") }, ["pending_action_id"]),
    run: async (a, ctx) => pendingStatus(a.pending_action_id, ctx),
  },

  // ------------------------------------------------------------ changes (each one waits for an owner)
  {
    name: "send_message", effect: "contact", perm: "messages:send",
    description: "Ask to text (or email) a customer. It waits for an owner's approval in the CRM, then goes out from the business number (dry-run until texting is switched on). Use Barta's voice: short, friendly, no em dashes.",
    inputSchema: S({ contact_id: ID("contact"), channel: str("sms (default) or email", { enum: ["sms", "email"] }), body: str("The message, under 1,600 characters"), subject: str("Email only") }, ["contact_id", "body"]),
    preview: async (a, ctx) => {
      const c = await contactFor(ctx, a.contact_id);
      const ch = a.channel || "sms";
      if (typeof a.body !== "string" || !a.body.trim()) throw new InputError("Write the message.", "body");
      if (a.body.length > 1600) throw new InputError("Keep it under 1,600 characters.", "body");
      const to = ch === "sms" ? phoneOf(c) : emailOf(c);
      if (!to) throw new InputError(ch === "sms" ? "They have no phone number on file." : "They have no email on file.", "channel");
      return { title: `${ch === "sms" ? "Text" : "Email"} ${nameOf(c)}`, rendered_text: `To ${nameOf(c)} (${to}):${a.subject ? "\nSubject: " + a.subject : ""}\n\n${a.body.trim()}`, recipients: [c.id] };
    },
    exec: async (a, ctx, action) => (await callRoute(ctx, "POST", "/messages", { body: { contact_id: a.contact_id, channel: a.channel || "sms", body: a.body.trim(), ...(a.subject ? { subject: a.subject } : {}), client_id: clientIdOf(action) } })).data,
  },
  {
    name: "create_lead", effect: "write", perm: "leads:create",
    description: "Ask to add a new lead (name, phone, email, address, what they want). An owner approves it first.",
    inputSchema: S({ first_name: str("First name"), last_name: str("Last name"), phone: str("Phone, like 763-555-0100"), email: str("Email"), street: str("Street address"), city: str("Town"), zip: str("ZIP"), services: { type: "array", items: { type: "string" }, description: "What they asked about" }, notes: str("Anything else") }, ["first_name"]),
    preview: async (a) => {
      if (!a.phone && !a.email) throw new InputError("Give a phone or an email.", "phone");
      return { title: `Add the lead ${[a.first_name, a.last_name].filter(Boolean).join(" ")}`, rendered_text: [[a.first_name, a.last_name].filter(Boolean).join(" "), a.phone, a.email, [a.street, a.city, a.zip].filter(Boolean).join(", "), (a.services || []).join(", "), a.notes].filter(Boolean).join("\n") };
    },
    exec: async (a, ctx, action) => {
      const body = { first_name: a.first_name, last_name: a.last_name || "", phone: a.phone, email: a.email, notes: a.notes, services: a.services, client_id: clientIdOf(action), force: true,
        ...(a.street || a.city || a.zip ? { address: { street1: a.street || "", city: a.city || "", state: "MN", zip: a.zip || "" } } : {}) };
      return (await callRoute(ctx, "POST", "/contacts", { body })).data;
    },
  },
  {
    name: "add_note", effect: "write", perm: "contacts:write",
    description: "Ask to add a note to a contact (an owner approves it first).",
    inputSchema: S({ contact_id: ID("contact"), text: str("The note") }, ["contact_id", "text"]),
    preview: async (a, ctx) => {
      const c = await contactFor(ctx, a.contact_id);
      if (!String(a.text || "").trim()) throw new InputError("Write the note.", "text");
      return { title: `Note on ${nameOf(c)}`, rendered_text: String(a.text).trim() };
    },
    exec: async (a, ctx) => (await callRoute(ctx, "POST", `/contacts/${a.contact_id}/notes`, { body: { text: String(a.text).trim() } })).data,
  },
  {
    name: "create_task", effect: "write", perm: "tasks:write",
    description: "Ask to create a task (a to-do, follow-up or call), optionally for a contact and a person, with a due time. An owner approves it first.",
    inputSchema: S({ title: str("What needs doing"), contact_id: ID("contact"), assignee_ids: { type: "array", items: { type: "string" }, description: "User ids (list_team)" }, due_at: str("When (ISO time, like 2026-11-18T15:00:00Z)"), kind: str("todo (default), follow_up, call, estimate_visit, meeting"), priority: str("low, medium (default) or high"), notes: str("Details") }, ["title"]),
    preview: async (a, ctx) => {
      if (!String(a.title || "").trim()) throw new InputError("Say what needs doing.", "title");
      const c = a.contact_id ? await contactFor(ctx, a.contact_id) : null;
      return { title: `Task: ${String(a.title).trim().slice(0, 80)}`, rendered_text: [String(a.title).trim(), c ? `For ${nameOf(c)}` : "", a.due_at ? `Due ${a.due_at}` : "", a.notes || ""].filter(Boolean).join("\n") };
    },
    exec: async (a, ctx, action) => (await callRoute(ctx, "POST", "/tasks", { body: { title: String(a.title).trim(), kind: a.kind || "todo", priority: a.priority || "medium", ...(a.contact_id ? { contact_id: a.contact_id } : {}), ...(Array.isArray(a.assignee_ids) ? { assignee_ids: a.assignee_ids } : {}), ...(a.due_at ? { due_at: a.due_at } : {}), notes: a.notes || "", client_id: clientIdOf(action) } })).data,
  },
  {
    name: "move_deal", effect: "write", perm: "sales:work",
    description: "Ask to move a deal in the pipeline: open, quoted, won, lost (with lost_reason) or abandoned. An owner approves it first.",
    inputSchema: S({ deal_id: ID("deal"), status: str("open, quoted, won, lost or abandoned", { enum: ["open", "quoted", "won", "lost", "abandoned"] }), lost_reason: str("When lost", { enum: ["price", "timing", "competitor", "no_response", "out_of_area", "spam", "other"] }), note: str("Why") }, ["deal_id", "status"]),
    preview: async (a, ctx) => {
      if (!isId(a.deal_id, "deal")) throw new InputError("Pass a deal id (list_deals).", "deal_id");
      const got = await getRecord("deal", a.deal_id);
      if (!got) throw new NotFoundError("That deal isn't there.");
      if (!ctx.can("sales:work")) throw new ForbiddenError("This key doesn't have access to deals.");
      return { title: `Move ${got.data.contact_name || "a deal"} to ${a.status}`, rendered_text: `${got.data.title || "Deal"}: ${got.data.status} → ${a.status}${a.lost_reason ? ` (${a.lost_reason})` : ""}${a.note ? "\n" + a.note : ""}` };
    },
    exec: async (a, ctx) => {
      if (a.status === "lost") return (await callRoute(ctx, "POST", `/deals/${a.deal_id}/lose`, { body: { reason: a.lost_reason || "other", note: a.note || "" } })).data;
      const got = await getRecord("deal", a.deal_id);
      if (!got) throw new NotFoundError("That deal isn't there.");
      return (await callRoute(ctx, "PATCH", `/deals/${a.deal_id}`, { body: { status: a.status }, ifMatch: got.etag })).data;
    },
  },
  {
    name: "create_quote", effect: "write", perm: "quotes:write",
    description: "Ask to start a draft quote for a contact, priced by the Barta engine from what you know (services: windows_ext, windows_int, screens, tracks_standard, tracks_premium, gutters; panes or square feet; an optional plan: biannual, quarterly, monthly). It stays a draft: a person checks it and sends it. An owner approves the draft first.",
    inputSchema: S({ contact_id: ID("contact"), services: { type: "array", items: { type: "string" } }, panes_ext: int("Outside panes"), panes_int: int("Inside panes"), sqft: int("Square feet (when panes aren't known)"), screens: int("Screens"), plan: str("biannual, quarterly or monthly"), client_notes: str("A note the customer sees") }, ["contact_id", "services"]),
    preview: async (a, ctx) => {
      const c = await contactFor(ctx, a.contact_id);
      if (!Array.isArray(a.services) || !a.services.length) throw new InputError("Pick the services.", "services");
      const ask = [a.services.join(", "), a.panes_ext ? `${a.panes_ext} outside panes` : "", a.panes_int ? `${a.panes_int} inside panes` : "", a.sqft ? `${a.sqft} sq ft` : "", a.screens ? `${a.screens} screens` : "", a.plan ? `${a.plan} plan` : "one-time"].filter(Boolean).join(", ");
      return { title: `Draft quote for ${nameOf(c)}`, rendered_text: `${ask}${a.client_notes ? "\nNote: " + a.client_notes : ""}\n\nIt stays a draft until someone sends it.` };
    },
    exec: async (a, ctx, action) => {
      const { services, panes_ext, panes_int, sqft, screens, plan } = a;
      const s = (await callRoute(ctx, "POST", "/pricing/suggest", { body: { input: { services, panes_ext, panes_int, sqft, screens, plan } } })).data || {};
      const option = { name: plan ? `${plan[0].toUpperCase()}${plan.slice(1)} plan` : "One-time", kind: s.plan ? "plan" : "one_time", recommended: true, lines: s.lines || [], discounts: s.discounts || [], ...(s.plan ? { plan: s.plan } : {}) };
      return (await callRoute(ctx, "POST", "/quotes", { body: { contact_id: a.contact_id, options: [option], client_notes: a.client_notes || "", client_id: clientIdOf(action) } })).data;
    },
  },
  {
    name: "create_job", effect: "contact", perm: "schedule:write",
    description: "Ask to create a job for a contact (title and lines; optionally a first visit with date, start time and crew, which tells the customer). An owner approves it first.",
    inputSchema: S({
      contact_id: ID("contact"), title: str("Like Exterior window cleaning"),
      lines: { type: "array", items: { type: "object", properties: { title: { type: "string" }, unit_cents: { type: "integer" }, qty: { type: "number" }, service_type: { type: "string" } }, required: ["title", "unit_cents"] } },
      target_month: str("YYYY-MM when it should happen (no date yet)"),
      visit: { type: "object", description: "A first visit", properties: { date: { type: "string" }, start: { type: "string", description: "HH:MM" }, assignee_ids: { type: "array", items: { type: "string" } } }, required: ["date", "start"] },
    }, ["contact_id", "title"]),
    preview: async (a, ctx) => {
      const c = await contactFor(ctx, a.contact_id);
      const lines = Array.isArray(a.lines) ? a.lines : [];
      const total = lines.reduce((s, l) => s + Math.round((Number(l.unit_cents) || 0) * (Number(l.qty) || 1)), 0);
      return { title: `Job for ${nameOf(c)}: ${String(a.title || "").slice(0, 60)}`, rendered_text: [String(a.title || ""), ...lines.map((l) => `${l.title}: $${((Number(l.unit_cents) || 0) / 100).toFixed(2)}${l.qty && l.qty !== 1 ? " × " + l.qty : ""}`), a.visit ? `First visit ${a.visit.date} at ${a.visit.start} (the customer is told)` : a.target_month ? `For ${a.target_month}` : ""].filter(Boolean).join("\n"), amount_cents: total };
    },
    exec: async (a, ctx, action) => {
      const lines = (a.lines || []).map((l) => ({ title: l.title, unit_cents: l.unit_cents, qty_milli: Math.round((Number(l.qty) || 1) * 1000), ...(l.service_type ? { service_type: l.service_type } : {}) }));
      return (await callRoute(ctx, "POST", "/jobs", { body: { contact_id: a.contact_id, title: a.title, lines, ...(a.target_month ? { target_month: a.target_month } : {}), ...(a.visit ? { visit: a.visit } : {}), client_id: clientIdOf(action) } })).data;
    },
  },
  {
    name: "cancel_job", effect: "write", perm: "schedule:write", confirm: true,
    description: "Ask to cancel a job and its open visits. Call it once to see what it would do and get a confirm_token; call it again with the same arguments and that token to ask an owner.",
    inputSchema: S({ job_id: ID("job"), reason: str("Why"), confirm_token: str("From the first call") }, ["job_id", "reason"]),
    preview: async (a, ctx) => {
      if (!isId(a.job_id, "job")) throw new InputError("Pass a job id.", "job_id");
      const got = await getRecord("job", a.job_id);
      if (!got || got.data.deleted_at) throw new NotFoundError("That job isn't there.");
      if (!ctx.can("schedule:write")) throw new ForbiddenError("This key doesn't have access to jobs.");
      const j = got.data;
      return { title: `Cancel job ${j.number_label || j.number} (${j.contact_name || "a customer"})`, rendered_text: `${j.title || "Job"}, ${j.status}. Its open visits come off the schedule.\nWhy: ${a.reason}` };
    },
    exec: async (a, ctx) => (await callRoute(ctx, "POST", `/jobs/${a.job_id}/cancel`, { body: { reason: a.reason } })).data,
  },
  {
    name: "archive_contact", effect: "write", perm: "contacts:write", confirm: true,
    description: "Ask to archive a contact (a duplicate, out of the area, do not contact, spam). Call it once for a confirm_token, then again with the same arguments and the token to ask an owner.",
    inputSchema: S({ contact_id: ID("contact"), reason: str("Why", { enum: ["duplicate", "out_of_area", "do_not_contact", "spam", "test", "vendor", "other"] }), confirm_token: str("From the first call") }, ["contact_id", "reason"]),
    preview: async (a, ctx) => {
      const c = await contactFor(ctx, a.contact_id);
      return { title: `Archive ${nameOf(c)}`, rendered_text: `Why: ${a.reason}` };
    },
    exec: async (a, ctx) => (await callRoute(ctx, "POST", `/contacts/${a.contact_id}/archive`, { body: { reason: a.reason } })).data,
  },
];

// Used by the tests and the connector screen.
export const TODAY = () => localDate(now());
export const lastMonth = () => { const first = TODAY().slice(0, 8) + "01"; const end = addLocalDays(first, -1); return { start: end.slice(0, 8) + "01", end }; };
