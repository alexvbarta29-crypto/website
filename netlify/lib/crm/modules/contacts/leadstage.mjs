// Contacts module: a lead's stage (guide-gaps S13, the owner's default: Rotor's
// seven stages as a real field, derived until someone moves it).
//
//   contact.lead_stage          one of LEAD_STAGES, set by a person (PATCH
//                               /contacts/:id or POST /contacts/bulk), or by
//                               the import from Rotor's stage
//   contact.lead_stage_at       when it last changed (time in stage, "Recently moved")
//   contact.lead_stage_by_hand  true once a person set it: the derived stage
//                               never overrides it
//
// The index row carries `lst` (the stored stage) and `lsa` (when). A lead
// without a stored stage gets one derived from what the CRM knows (pure,
// deriveLeadStage): won or a customer → sold, a lost deal → not_interested,
// in the estimate follow-up → follow_up, a quote out → quoted, a call or
// text → contacted, else new. The Leads board uses the same rule.

export const LEAD_STAGES = Object.freeze(["new", "contacted", "quoted", "follow_up", "sold", "not_interested", "not_ready"]);
export const LEAD_STAGE_LABELS = Object.freeze({
  new: "New", contacted: "Contacted", quoted: "Quoted", follow_up: "Follow-Up", sold: "Sold", not_interested: "Not Interested", not_ready: "Not Ready",
});

// Rotor's stage words (as the import stored them) → ours, or null.
export function rotorStage(raw) {
  const k = String(raw || "").toLowerCase().replace(/[^a-z]/g, "");
  return ({ new: "new", newlead: "new", contacted: "contacted", quoted: "quoted", estimatesent: "quoted", followup: "follow_up",
    sold: "sold", won: "sold", notinterested: "not_interested", lost: "not_interested", notready: "not_ready" })[k] || null;
}

// The stage a contact record holds (by hand, or from the import). → a stage or null.
export const storedStage = (c) => (c && LEAD_STAGES.includes(c.lead_stage) ? c.lead_stage : rotorStage(c && c.rotor && c.rotor.stage));

// The stage of an index row (pure). row = the contacts index row; facts =
// { deal: { st } | null, enrollment: { cad } | null } from the sales module.
export function deriveLeadStage(row, { deal = null, enrollment = null } = {}) {
  if (!row) return "new";
  if (LEAD_STAGES.includes(row.lst)) return row.lst;
  if (row.lc === "customer" || row.lc === "former_customer" || (deal && deal.st === "won")) return "sold";
  if (deal && deal.st === "lost") return "not_interested";
  if (enrollment && /estimate|quote/i.test(String(enrollment.cad || enrollment.lbl || ""))) return "follow_up";
  if (row.oq || (deal && deal.st === "quoted")) return "quoted";
  if (row.slc || row.lca) return "contacted";
  return "new";
}
