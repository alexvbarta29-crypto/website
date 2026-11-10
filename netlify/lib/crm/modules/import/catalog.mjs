// The import's map of Rotor (design §10.1, §10.2): which entity files an
// export holds, and which phase of which module turns each into CRM records.
//
// A module brings its phases in its manifest (`importPhases`); the runner
// runs every registered phase. This catalog only names the phases the
// design expects from modules that are not built yet, so a run can say
// "waiting for Quotes" instead of silently importing nothing, and the
// report can show how many staged rows wait for each module.

// Every entity file the export holds (§10.1 step 1), plus the site's own
// stores the contacts phases link by phone (row 36).
export const ENTITIES = Object.freeze([
  "members", "member_availability", "availability_exceptions", "rate_settings", "crews", "customers", "leads", "quote_contacts",
  "pipelines", "pipeline_stages", "opportunities", "tasks", "quotes", "service_plans", "agreement_templates", "jobs", "visits",
  "visit_timers", "timesheets", "payroll", "invoices", "payments", "messages", "message_templates", "campaigns", "map_pin_types",
  "giveaway_entrants", "referrals",
]);
export const ENTITY_RE = /^[a-z][a-z0-9_]{0,40}$/;

// Phases the design names for modules that have not registered theirs yet:
// { name, module, entity, row, label }. The runner lists a missing one as
// "waiting" (the module ships it later; the next run imports it).
export const EXPECTED_PHASES = Object.freeze([
  { name: "work.time_off", module: "work", entity: "availability_exceptions", row: 3, label: "Time off" },
  { name: "quotes.price_book", module: "quotes", entity: "quotes", row: 4, label: "Price book" },
  { name: "quotes.discounts", module: "quotes", entity: "quotes", row: 5, label: "Discounts" },
  { name: "sales.pipelines", module: "sales", entity: "pipelines", row: 13, label: "Pipelines and stages" },
  { name: "sales.opportunities", module: "sales", entity: "opportunities", row: 14, label: "Opportunities" },
  { name: "sales.tasks", module: "sales", entity: "tasks", row: 15, label: "Tasks" },
  { name: "comms.templates", module: "comms", entity: "message_templates", row: 16, label: "Message templates" },
  { name: "plans.agreement_templates", module: "plans", entity: "agreement_templates", row: 17, label: "Agreement templates" },
  { name: "quotes.quotes", module: "quotes", entity: "quotes", row: 18, label: "Quotes" },
  { name: "plans.plans", module: "plans", entity: "service_plans", row: 19, label: "Service plans" },
  { name: "work.jobs", module: "work", entity: "jobs", row: 22, label: "Jobs" },
  { name: "work.visits", module: "work", entity: "visits", row: 23, label: "Visits" },
  { name: "work.timers", module: "work", entity: "visit_timers", row: 24, label: "Visit timers" },
  { name: "plans.lights", module: "plans", entity: "service_plans", row: 25, label: "Christmas lights seasons" },
  { name: "work.timesheets", module: "work", entity: "timesheets", row: 26, label: "Timesheets" },
  { name: "money.invoices", module: "money", entity: "invoices", row: 27, label: "Invoices" },
  { name: "money.payments", module: "money", entity: "payments", row: 28, label: "Payments" },
  { name: "payroll.payroll", module: "payroll", entity: "payroll", row: 31, label: "Payroll" },
  { name: "comms.messages", module: "comms", entity: "messages", row: 32, label: "Messages" },
  { name: "comms.campaigns", module: "comms", entity: "campaigns", row: 33, label: "Campaigns" },
  { name: "comms.pin_types", module: "comms", entity: "map_pin_types", row: 35, label: "Map pin types" },
]);

// Plain-English names for the phases the screen and the report show.
export const PHASE_LABELS = Object.freeze({
  "system.users": "Team (Rotor members)",
  "system.availability": "Team availability",
  "system.rates": "Pay rates",
  "contacts.customers": "Customers",
  "contacts.quote_contacts": "Consent, Stripe ids, converted leads",
  "contacts.leads": "Leads",
  "contacts.properties_quotes": "Properties from quotes",
  "contacts.properties_plans": "Properties from plans",
  "contacts.properties_visits": "Properties from visits",
  "contacts.suppressions": "STOP replies (opt-outs)",
  "contacts.giveaway": "Giveaway entrants",
  "contacts.referrals": "Referrals",
  "sales.pipeline_stages": "Pipeline stages",
  "sales.lead_follow_ups": "Lead follow-up dates",
  ...Object.fromEntries(EXPECTED_PHASES.map((p) => [p.name, p.label])),
});

export const MODULE_LABELS = Object.freeze({ sales: "Sales", quotes: "Quotes", plans: "Plans", work: "Scheduling", money: "Money", comms: "Messages", payroll: "Payroll" });

export const phaseLabel = (name) => PHASE_LABELS[name] || String(name).replace(/^[a-z]+\./, "").replace(/_/g, " ");
