// Sales module: the seeded cadences and templates (design §5.2 "Seeded
// cadences", §5.7.3, barta-rules §3, D20-D22, D25).
//
// The texts are the office playbook's (netlify/lib/playbook-page.mjs, the
// /playbook Follow-ups page) in the CRM's {{variable}} syntax: {first} →
// {{first_name|there}}, {rep} → {{sender_first_name}}, {reviews} →
// {{review_count|150}} (the playbook's own fallback), {link} →
// {{review_link}}; "BARTA Window Washing" stays as the playbook writes it.
// Texts 5 and 8 are reworded (D25): "fully insured" (not "licensed"), and
// the satisfaction promise as a free re-clean, without the refund clause.
// No template ever says "Reply STOP to opt out": the sender adds the footer
// when it is needed (D5).
//
// Templates are declared in the manifest and written once by core's
// templates.seed sweep; cadences are written once by system.seed
// (§11.1 rule 6) under fixed ids, so a re-deploy never duplicates them and
// an owner's edits are never overwritten. ensureCadence() writes the same
// record under the same id when a lead arrives before the first worker pass.

import { createRecord, getRecord, readPointer } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { ExistsError } from "../../core/errors.mjs";

const w = (start, end) => ({ start, end });
const W9 = w("09:00", "10:00");
const W12 = w("12:00", "13:00");
const W16 = w("16:00", "17:00");

// ------------------------------------------------------------ templates

export const CADENCE_TEXTS = Object.freeze({
  cad_new_1: "Hey {{first_name|there}}! This is {{sender_first_name}} with BARTA Window Washing. I saw you requested a quote to get your windows cleaned. Give me a ring back whenever you get a sec and I'd love to get you that free quote. Have a great day!",
  cad_new_2: "Hey {{first_name|there}}, just missed you again! In case it helps while we're playing a little phone tag, here are our reviews. We've got over {{review_count|150}} 5 star ratings you can read through: {{review_link}}",
  cad_new_3: "Hey it's {{sender_first_name}}, kept missing you today! No rush at all, I'll try you again tomorrow to get you that free quote. I'd really love to connect so I can make sure I get you the most accurate price for your home. Talk soon!",
  cad_new_4: "Good morning {{first_name|there}}! This is {{sender_first_name}} with BARTA Window Washing. I gave you a quick call to get you that quote on your windows but didn't catch you. I'll be around all day, so whenever you get a free minute just call me back. Thanks so much!",
  cad_new_5: "Hey, just missed you again! You're probably getting a few other quotes, so here's a few pointers for how to find the right person for the job. 1) fully insured so you and your property are protected, 2) frames and sills included, not just the glass, and 3) a 100% satisfaction guarantee. PS we do all of those things!",
  cad_new_6: "Hey {{first_name|there}}, wasn't able to reach you today but I'll give you another call tomorrow morning to get you that quote. If now's just not the best time, no worries at all, just let me know what works! Have a wonderful evening.",
  cad_new_7: "Hey {{first_name|there}}, I know I've reached out a few times, and I know you're busy! I just don't want to leave you hanging on that quote you requested. It would only be like a 5 min call.",
  cad_new_8: "Hey, missed you again today! Real quick, one thing I love about us is our 100% satisfaction guarantee. If you're ever not happy with the job, we'll come back and re-clean it free of charge. So there's truly no risk on your end. Would love to get you that quote whenever you're free!",
  cad_new_9: "Hey {{first_name|there}}, since we keep missing each other, I'll go ahead and put your quote together and send it right over. Take a look when you get a sec and let me know what you think! Happy to answer any questions.",
  cad_est_1: "Hey {{first_name|there}}, it's {{sender_first_name}} with BARTA Window Washing. Just wanted to make sure you got everything you need on your window cleaning estimate. If any questions came up, I'm happy to walk through them. Want me to go ahead and find you a spot on the schedule?",
  cad_est_2: "Hey {{first_name|there}}, one more thing! Our schedule's been filling up fast lately, so if you're leaning toward getting your windows done I'd hate for you to have to wait. Just send me a day that works and I'll hold a spot for you. No pressure either way!",
  cad_est_3: "Hey {{first_name|there}}! Good news, I was able to take $50 off your estimate to help make this an easy yes for you. That price is good whenever you're ready to book, just send me a day that works and I'll get you locked in!",
  cad_est_4: "Hey {{first_name|there}}! Wanted to sweeten the deal one more time. On top of the $50 off your estimate, if you book today we can also clean 10 screens for free for you. Just let me know a day that works and I'll lock it all in for you!",
  cad_est_5: "Hey {{first_name|there}}, since I haven't heard back I'm going to go ahead and archive your quote, which means the $50 off and free screen cleaning will expire. If you still want to get your windows done, just let me know asap and I can get you taken care of before those discounts are gone. Otherwise no worries at all, just reach out whenever you're ready!",
});

// Rotor's new-lead auto-text (rotor-comms §7.2), without the footer Rotor added.
export const LEAD_ACK_TEXT = "Hi {{first_name|there}}! Thanks for reaching out to BARTA Window Washing. I’d love to learn a little more about what you’re looking to have done and get you an accurate quote. When would be a good time for a quick call?";
export const STAFF_NEW_LEAD_TEXT = "New lead: {{first_name|Someone}} in {{town|the area}}. Open Leads & calls in the CRM to call them.";

const NEW_NAMES = ["Day 1 call 1 text", "Day 1 call 2 text", "Day 1 call 3 text", "Day 2 call 4 text", "Day 2 call 5 text", "Day 2 call 6 text", "Day 3 call 7 text", "Day 3 call 8 text", "Day 3 call 9 text"];
const EST_NAMES = ["Estimate day 1 morning", "Estimate day 1 evening", "Estimate day 2 ($50 off)", "Estimate day 3 (10 free screens)", "Estimate day 4 (archive)"];

export const TEMPLATES = Object.freeze([
  ...Object.entries(CADENCE_TEXTS).map(([key, body]) => {
    const est = key.startsWith("cad_est_");
    const i = Number(key.slice(-1)) - 1;
    return { key, name: est ? `Follow-up: ${EST_NAMES[i]}` : `New lead: ${NEW_NAMES[i]}`, channel: "sms", category: "service", body, tags: ["cadence", est ? "estimate_followup" : "new_lead"] };
  }),
  { key: "lead_ack", name: "New lead thank-you", channel: "sms", category: "service", body: LEAD_ACK_TEXT, tags: ["lead"] },
  { key: "staff_new_lead", name: "New lead (to staff)", channel: "sms", category: "staff", body: STAFF_NEW_LEAD_TEXT, tags: ["staff"] },
]);

// ------------------------------------------------------------ cadences

export const NEW_LEAD_SOURCES = Object.freeze(["Website quote form", "Meta Ads", "Referral", "Phone Call", "Email", "Facebook Messenger", "Inbound text", "Other"]);
const NEW_LABELS = ["Day 1 - Call + VM/Text (1)", "Day 1 - Call/Text (2)", "Day 1 - Call/Text (3)", "Day 2 - Call + VM/Text (4)", "Day 2 - Call/Text (5)", "Day 2 - Call/Text (6)",
  "Day 3 - Call + VM/Text (7)", "Day 3 - Call/Text (8)", "Day 3 - Call/Text (9)"];
const WINDOWS = [W9, W12, W16];

export const SEED_CADENCES = Object.freeze([
  {
    key: "new_lead",
    name: "New lead - no estimate yet",
    description: "Contact throughout the day 9-10, 12-1, 4-5. Call first, every time; text only when they don't pick up.",
    active: true, board_only: false,
    entry: { on: "lead.created", sources: [...NEW_LEAD_SOURCES], exclude_tags: ["Giveaway - New Lead"] },
    exit_on: ["quote_sent", "booked", "opted_out", "won", "lost"],
    on_reply: "pause", unattended: "wait",
    steps: [
      ...NEW_LABELS.map((label, i) => ({ day: Math.floor(i / 3) + 1, window: WINDOWS[i % 3], action: "call_then_text", template_key: `cad_new_${i + 1}`, review_before_send: false, label })),
      { day: 3, action: "task", task_title: "Send estimate", review_before_send: false, label: "Send Estimate" },
    ],
  },
  {
    key: "estimate_followup",
    name: "Estimate sent - not scheduled",
    description: "Read before you send: reference what you actually discussed. 5 touches over 4 days, call first each time.",
    active: true, board_only: false,
    entry: { on: "quote.sent" },
    exit_on: ["quote_approved", "quote_declined", "changes_requested", "opted_out", "booked", "won", "lost"],
    on_reply: "pause", unattended: "wait",
    steps: [
      { day: 1, window: W9, action: "call_then_text", template_key: "cad_est_1", review_before_send: true, label: "Day 1 [Morning]- Call + VM/Text (1)" },
      { day: 1, window: W16, action: "call_then_text", template_key: "cad_est_2", review_before_send: true, label: "Day 1 [Evening]- Call/Text (2)" },
      { day: 2, window: W9, action: "call_then_text", template_key: "cad_est_3", review_before_send: true, offer: "followup_50", label: "Day 2 [Morning] - Call + VM/Text (3)" },
      { day: 3, window: W12, action: "call_then_text", template_key: "cad_est_4", review_before_send: true, offer: "ten_free_screens", label: "Day 3 [Afternoon] - Call + VM/Text (4)" },
      { day: 4, window: W16, action: "call_then_text", template_key: "cad_est_5", review_before_send: true, archive_quote: true, label: "Day 4 [Evening] - Call + VM/Text (5)" },
    ],
  },
  {
    key: "giveaway", name: "Giveaway", description: "Board only: Entrants, $250 Claimed, Winners.",
    active: true, board_only: true, entry: { on: "tag.added", tag: "Giveaway 2026" }, exit_on: [], on_reply: "pause", unattended: "wait", steps: [],
    board_stages: ["Entrants", "$250 Claimed", "Winners"],
  },
  {
    key: "referrals", name: "Referrals", description: "Retired with the referral program; kept for history.",
    active: false, board_only: true, entry: { on: "manual" }, exit_on: [], on_reply: "pause", unattended: "wait", steps: [],
    board_stages: ["New", "In Progress", "Completed"],
  },
]);

export const seedCadenceId = (key) => deriveId("cadence", "seed:cadence", "sales", key);
export const seedCadence = (key) => SEED_CADENCES.find((c) => c.key === key) || null;

// The cadence a key names, or null. A seeded key that isn't written yet
// (a lead before the first worker pass) is written now, under its seed id.
export async function cadenceByKey(key, ctx = {}, { ensure = true } = {}) {
  const p = await readPointer("cadence-key", key);
  if (p && isId(p.id, "cadence")) {
    const got = await getRecord("cadence", p.id);
    if (got && !got.data.deleted_at) return got.data;
  }
  const seed = seedCadence(key);
  if (!seed || !ensure) return null;
  const id = seedCadenceId(key);
  try {
    return (await createRecord("cadence", { ...JSON.parse(JSON.stringify(seed)), id }, { ...ctx, by: "system", origin: ctx.origin || "worker", actor_kind: ctx.actor_kind || "automation", audit: true })).data;
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    const got = await getRecord("cadence", id);
    return got ? got.data : null;
  }
}

// system.seed: the four cadences, once each (a key someone already used is left alone).
export async function seedCadences(ctx) {
  let created = 0;
  for (const seed of SEED_CADENCES) {
    if (await readPointer("cadence-key", seed.key)) continue;
    try {
      await createRecord("cadence", { ...JSON.parse(JSON.stringify(seed)), id: seedCadenceId(seed.key) }, ctx.write ? ctx.write() : ctx);
      created += 1;
    } catch (e) {
      if (!(e instanceof ExistsError)) throw e;
    }
  }
  return { created };
}
