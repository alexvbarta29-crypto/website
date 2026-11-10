// Contacts module: lead intake (design §6.8, §6.7, §5.1 "Intake", B2).
//
// intakeLead(input, { origin, rotor }) is the one way a lead from outside
// becomes a contact: the website's quote form, the giveaway, referrals and
// referral claims (in-process, from lead.mjs, giveaway-rotor.mjs,
// claim.mjs and referral-notify.mjs, after Rotor), and the lead webhook
// (Meta leads through Zapier). One address, one contact, even under a double
// submit, the giveaway's two-step write, a Zapier retry, or Meta and the
// website for the same person:
//
//   1. normalize; hk of the phone (else the email)
//   2. provider dedupe: a Meta leadgen id seen before → its contact, nothing else
//   3. per-address lease lock/intake/{hk} = { holder, lease_until, n }: a
//      request that finds it held waits up to 2 s (polling every 250 ms),
//      then continues and upserts onto whatever the winner made
//   4. match by phone, then email (following merges); upsert onto the most
//      recently updated non-archived match: fill only empty fields, append
//      the note block once, merge tags, grant consent only where it is unknown
//      (a CAS that keeps losing to the same person's other requests retries)
//   5. else create, id = deriveId(contact, intake--{hk}, n): a retried
//      request that lost its lease lands on the same record
//   6. Rotor link: the lead id Rotor answered claims ptr/rotor/lead/{rid};
//      without one the contact is marked intake_pending_rotor for the import
//   7. a new lead (not a giveaway entry: those get tags only), or a
//      contact that wasn't a lead whose record this request changed →
//      sales.enroll once and lead.created (the same request again: nothing)
//   8. release the lease (CAS to an expired value)
//
// While Rotor is the system of record, intake is automation (§0 rule 12):
// on a contact the import brought in it changes no field Rotor owns. It
// records what it would have changed (alog would-update), keeps the request
// on the timeline (an "intake" event with the note) and still links the
// Rotor lead id by pointer, so the next import updates that contact in place.
//
// Never throws: → { ok, contact_id?, created, event?, enrollment_id?, error? }.
// ok means this request left a durable trace: the contact created or
// changed, or (nothing to change) its intake event written.
// Logs carry codes and counts only.

import { createHash, randomBytes } from "node:crypto";
import {
  getRaw, settledWrite, readPointer, claimPointer, getRecord, createRecord, updateRecord, addActivity, appendEvent, hk,
} from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { nowIso, nowMs, now } from "../../core/clock.mjs";
import { ExistsError, InputError, StaleError } from "../../core/errors.mjs";
import { guardFor } from "../../core/context.mjs";
import { emit } from "../../core/events.mjs";
import { has, call } from "../../core/services.mjs";
import { readSysMode } from "../../core/settings.mjs";
import { wouldAct } from "../../core/activity.mjs";
import { keySafe } from "../../core/text.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { normalizePhone, normalizeEmail, normalizeAddress, dateLabel, rotorKey } from "./display.mjs";
import { cleanTags, MAX_TAGS } from "./types.mjs";
import { contactsAt, pickUpsertTarget, resolveContact, createCandidate } from "./match.mjs";
import { ensureProperty } from "./properties.mjs";

export const LEASE_MS = 30 * 1000;
export const WAIT_POLLS = 8;           // 8 × 250 ms = the 2 s a losing request waits
export const POLL_MS = 250;
// A busy contact (many requests for one person at once): the fill-only
// upsert is idempotent, so a CAS that kept losing tries again a few times.
export const UPSERT_ROUNDS = 4;
export const ORIGINS = Object.freeze(["lead-form", "giveaway", "giveaway-claim", "referral", "claim", "webhook", "app"]);
// Giveaway entries and coupon claims get tags and notes only, never the
// new-lead cadence (Rotor's two-step write keeps them out of its pipeline too).
export const TAGS_ONLY = Object.freeze(new Set(["giveaway", "giveaway-claim"]));
export const DEFAULT_SOURCE = Object.freeze({
  "lead-form": "Website quote form", giveaway: "Holiday Lights Giveaway", "giveaway-claim": "Holiday Lights Giveaway",
  referral: "Referral", claim: "Referral", webhook: "Meta Ads", app: "Other",
});
const CONSENT_SOURCE = { sms_service: "website_form", sms_marketing: "giveaway_optin" };

const str = (v) => (v == null ? "" : String(v)).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms * (globalThis.__crmSleepScale ?? 1))));
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
export const leadgenKey = (id) => sha(`leadgen:${id}`).slice(0, 40);

// ------------------------------------------------------------ input

// The intake input (§6.8) → what the contact needs. Throws InputError.
export function normalizeInput(input = {}, origin = "lead-form") {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("Expected a lead.");
  let first = str(input.first_name).slice(0, 80);
  let last = str(input.last_name).slice(0, 80);
  if (!first && !last && str(input.name)) {
    const parts = str(input.name).split(/\s+/);
    first = parts[0].slice(0, 80);
    last = parts.slice(1).join(" ").slice(0, 80);
  }
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);
  const address = normalizeAddress(input.address || {});
  const tags = cleanTags([...(Array.isArray(input.tags) ? input.tags : [])].slice(0, MAX_TAGS), "tags");
  const services = (Array.isArray(input.services) ? input.services : []).map(str).filter(Boolean).slice(0, 20);
  const src = typeof input.source === "object" && input.source ? input.source : { source: input.source };
  const source = { source: str(src.source).slice(0, 60) || DEFAULT_SOURCE[origin] || "Other" };
  for (const k of ["channel", "form", "ad", "county", "campaign", "promo_code", "referral_code", "landing_page"]) {
    const v = str(src[k] ?? input[k]).slice(0, 120);
    if (v) source[k] = v;
  }
  if (!source.channel && str(input.referral_source)) source.channel = str(input.referral_source).slice(0, 120);
  if (!source.landing_page && str(input.page)) source.landing_page = str(input.page).slice(0, 120);
  const consent = input.consent && typeof input.consent === "object" ? input.consent : {};
  return {
    first_name: first, last_name: last, company_name: str(input.company_name).slice(0, 120),
    phone: phone.e164, phone_problem: phone.e164 ? null : phone.problem, email, address, tags, services,
    service_type: str(input.service_type).slice(0, 100), source,
    provider_lead_id: str(input.provider_lead_id).slice(0, 80) || null,
    consent: { sms_service: consent.sms_service === true, sms_marketing: consent.sms_marketing === true },
    note: str(input.notes || input.note).slice(0, 4000),
  };
}

// The block a submission adds to the contact's notes (once: a retried or
// repeated submission with the same words adds nothing).
export function noteBlock(n, origin, at = now()) {
  if (!n.note) return "";
  return `— ${n.source.source}, ${dateLabel(at)} —\n${n.note}`;
}
export function appendNote(notes, block) {
  const cur = String(notes || "");
  if (!block) return cur;
  const body = block.slice(block.indexOf("\n") + 1);
  if (body && cur.includes(body)) return cur;
  return (cur.trim() ? cur.replace(/\s+$/, "") + "\n\n" + block : block).slice(0, 10000);
}

// What a new lead's contact record holds.
function newContact(n, origin, { rotorLeadId, pendingRotor }) {
  const at = nowIso();
  const consent = { sms_service: { state: "unknown" }, sms_marketing: { state: "unknown" }, email_marketing: { state: "unknown" } };
  for (const ch of ["sms_service", "sms_marketing"]) if (n.consent[ch]) consent[ch] = { state: "granted", at, source: CONSENT_SOURCE[ch] };
  return {
    kind: !n.first_name && !n.last_name && n.company_name ? "business" : "person",
    first_name: n.first_name, last_name: n.last_name, company_name: n.company_name,
    phones: n.phone ? [{ e164: n.phone, label: "mobile", primary: true, sms: true }] : [],
    emails: n.email ? [{ address: n.email, label: "personal", primary: true }] : [],
    lifecycle: "lead", source: { ...n.source, captured_at: at }, tags: n.tags,
    notes: noteBlock(n, origin), consent, flags: {}, watcher_ids: [],
    ...(n.address ? { billing_address: n.address } : {}),
    ...(rotorLeadId ? { rotor: { lead_ids: [rotorLeadId] } } : {}),
    ...(pendingRotor ? { intake_pending_rotor: pendingRotor } : {}),
  };
}

// The fill-only upsert of a submission onto an existing contact (§5.1
// "Intake"): pure; null when nothing changes.
export function upsertFields(c, n, origin, { rotorLeadId, pendingRotor } = {}) {
  const next = JSON.parse(JSON.stringify(c));
  const at = nowIso();
  if (!str(next.first_name) && !str(next.last_name) && (n.first_name || n.last_name)) {
    next.first_name = n.first_name; next.last_name = n.last_name;
  }
  if (!str(next.company_name) && n.company_name) next.company_name = n.company_name;
  next.phones = Array.isArray(next.phones) ? next.phones : [];
  if (n.phone && !next.phones.some((p) => p.e164 === n.phone)) next.phones.push({ e164: n.phone, label: "mobile", primary: next.phones.length === 0, sms: true });
  next.emails = Array.isArray(next.emails) ? next.emails : [];
  if (n.email && !next.emails.some((e) => e.address === n.email)) next.emails.push({ address: n.email, label: "personal", primary: next.emails.length === 0 });
  if (!next.billing_address && n.address) next.billing_address = n.address;
  const tags = [...(next.tags || [])];
  for (const t of n.tags) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase()) && tags.length < MAX_TAGS) tags.push(t);
  next.tags = tags;
  next.notes = appendNote(next.notes, noteBlock(n, origin));
  next.consent = next.consent || {};
  for (const ch of ["sms_service", "sms_marketing"]) {
    const cur = next.consent[ch] && next.consent[ch].state;
    if (n.consent[ch] && (!cur || cur === "unknown")) next.consent[ch] = { state: "granted", at, source: CONSENT_SOURCE[ch] };
  }
  if (rotorLeadId) {
    next.rotor = { ...(next.rotor || {}), lead_ids: [...new Set([...((next.rotor && next.rotor.lead_ids) || []), rotorLeadId])] };
    delete next.intake_pending_rotor;
  } else if (pendingRotor && !next.intake_pending_rotor && !(next.rotor && (next.rotor.customer_id || (next.rotor.lead_ids || []).length))) {
    next.intake_pending_rotor = pendingRotor;
  }
  return JSON.stringify(next) === JSON.stringify(c) ? null : next;
}

// ------------------------------------------------------------ the lease

// → { held, n, etag? }. A held, unexpired lease is waited for up to WAIT_POLLS
// × POLL_MS; then the request goes on without it (n = the holder's).
export async function takeLease(addrHk, holder, opts = {}) {
  const key = `lock/intake/${addrHk}`;
  let lastN = 1;
  for (let i = 0; i <= WAIT_POLLS + 3; i++) {
    const cur = await getRaw(key, opts);
    const d = cur && cur.data;
    const held = !!(d && d.holder && Date.parse(d.lease_until) > nowMs());
    if (!held) {
      const n = d && Number.isSafeInteger(d.n) ? d.n + 1 : 1;
      const w = await settledWrite(key, { holder, lease_until: new Date(nowMs() + LEASE_MS).toISOString(), n, at: nowIso() }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true }, opts);
      if (w.ok) return { held: true, n, key, etag: w.etag };
      continue;                      // someone else just took it: look again
    }
    lastN = Number.isSafeInteger(d.n) ? d.n : 1;
    if (i >= WAIT_POLLS) break;
    await sleep(POLL_MS);
  }
  return { held: false, n: lastN, key };
}

export async function releaseLease(lease, holder, opts = {}) {
  if (!lease || !lease.held) return;
  try {
    const cur = await getRaw(lease.key, opts);
    if (!cur || !cur.data || cur.data.holder !== holder) return;
    await settledWrite(lease.key, { holder: null, lease_until: new Date(0).toISOString(), n: cur.data.n, released_at: nowIso() }, { onlyIfMatch: cur.etag }, opts);
  } catch (e) {
    console.error(`crm:intake: lease not released (${safeErr(e)}); it expires on its own`);
  }
}

// ------------------------------------------------------------ intake

const nonce = () => randomBytes(6).toString("hex");

export async function intakeLead(input, { origin = "lead-form", rotor = null, by, mode: givenMode, requestId } = {}, opts = {}) {
  if (!ORIGINS.includes(origin)) return { ok: false, created: false, error: "bad_origin" };
  let n;
  try { n = normalizeInput(input, origin); } catch (e) {
    return { ok: false, created: false, error: "invalid", ...(e instanceof InputError && e.field ? { field: e.field } : {}) };
  }
  if (!n.phone && !n.email) return { ok: false, created: false, error: "no_contact" };
  const holder = `intake.${requestId || nonce()}`;
  let lease = null;
  let addrHk;
  try {
    addrHk = n.phone ? hk("phone", n.phone) : hk("email", n.email);
    const mode = givenMode || await readSysMode(opts);
    const ctx = { by: by || `hook:${keySafe(origin, 30)}`, origin: "hook", actor_kind: "automation", requestId: holder, mode };
    const guard = guardFor(mode);
    const rotorLeadId = rotor && typeof rotor.lead_id === "string" && /^[\w.-]{1,64}$/.test(rotor.lead_id) ? rotor.lead_id : null;
    const pendingRotor = rotorLeadId ? null : {
      ...(n.phone ? { phone_hk: hk("phone", n.phone) } : {}), ...(n.email ? { email_hk: hk("email", n.email) } : {}), at: nowIso(),
    };

    // 2. a Meta lead seen before: its contact, nothing else
    const metaKey = n.provider_lead_id ? leadgenKey(n.provider_lead_id) : null;
    const seen = async () => {
      if (!metaKey) return null;
      const p = await readPointer("meta-lead", metaKey, opts);
      if (!p || !isId(p.id, "contact")) return null;
      const r = await resolveContact(p.id, opts);
      return r ? r.id : p.id;
    };
    const before = await seen();
    if (before) return { ok: true, contact_id: before, created: false, duplicate: true };

    // 3. one intake per address at a time
    lease = await takeLease(addrHk, holder, opts);
    const after = await seen();
    if (after) return { ok: true, contact_id: after, created: false, duplicate: true };

    // 4. match by phone, then email
    let matches = n.phone ? await contactsAt("phone", n.phone, opts) : [];
    if (!matches.length && n.email) matches = await contactsAt("email", n.email, opts);
    let target = pickUpsertTarget(matches);
    let contact = null;
    let created = false;
    let changed = false;
    let wasLead = false;

    if (!target) {
      // 5. create (the id comes from the address and the lease's n)
      const id = deriveId("contact", `intake--${addrHk}`, "contacts.intake", lease.n);
      try {
        contact = (await createRecord("contact", { ...newContact(n, origin, { rotorLeadId, pendingRotor }), id }, ctx)).data;
        created = true;
        changed = true;
      } catch (e) {
        if (!(e instanceof ExistsError)) throw e;
        const got = await resolveContact(id, opts);
        if (!got) throw e;
        target = got;
      }
      // the only matches were archived: the office decides whether they are one person
      if (created) for (const m of matches.slice(0, 3)) await createCandidate(contact.id, m.id, { reason: n.phone ? "phone" : "email", confidence: "high" }, ctx).catch(() => null);
    }
    if (target) {
      wasLead = target.data.lifecycle === "lead";
      if (guard.mayAct({ record: target.data })) {
        // a merge that starts between the read and the write: the upsert follows it to the survivor
        let moved = null;
        const upsert = (c) => { if (c.merging_into || c.merged_into) { moved = c.merging_into || c.merged_into; return null; } return upsertFields(c, n, origin, { rotorLeadId, pendingRotor }); };
        // a CAS that kept losing (many requests for one person at once) tries again: the upsert is fill-only
        const upsertOnto = async (id) => {
          for (let round = 0; ; round++) {
            try { return await updateRecord("contact", id, upsert, ctx); } catch (e) {
              if (!(e instanceof StaleError) || round >= UPSERT_ROUNDS) throw e;
              await sleep(20 * (round + 1) + randomBytes(1)[0] % 40);
            }
          }
        };
        let r = await upsertOnto(target.id);
        for (let hop = 0; moved && hop < 3; hop++) {
          const next = await resolveContact(moved, opts);
          moved = null;
          if (!next) break;
          r = await upsertOnto(next.id);
        }
        contact = r.data;
        changed = r.changed === true;
      } else {
        // Rotor owns this contact until cutover: report what would change, keep the request on its timeline
        contact = target.data;
        const would = upsertFields(target.data, n, origin, { rotorLeadId, pendingRotor });
        if (would) {
          const fields = Object.keys(would).filter((k) => JSON.stringify(would[k]) !== JSON.stringify(target.data[k]));
          await wouldAct({ key: "contacts.intake", subject: target.id, action: "update", changes: { fields } }, opts).catch(() => {});
        }
      }
    }

    // Meta: this leadgen id now names the contact
    if (metaKey) await claimPointer("meta-lead", metaKey, { id: contact.id }, opts).catch((e) => console.error(`crm:intake: leadgen pointer not saved (${safeErr(e)})`));
    // 6. Rotor's lead id (dual-write): the import resolves through this pointer first (§10.3)
    if (rotorLeadId) {
      const p = await claimPointer("rotor/lead", rotorKey(rotorLeadId), { id: contact.id }, opts).catch(() => ({ ok: false }));
      if (!p.ok && p.current && p.current.id && p.current.id !== contact.id) console.error("crm:intake: a Rotor lead id already names another contact");
    }

    // a property for a new lead's address (contacts the import owns get theirs from the import)
    if (n.address && n.address.street1 && guard.mayAct({ record: contact })) {
      await ensureProperty(contact.id, n.address, ctx).catch((e) => console.error(`crm:intake: property not saved (${safeErr(e)})`));
    }

    // the request on the timeline, whoever owns the fields. The intake event
    // is this request's durable trace when the record itself didn't change
    // (a contact the import owns, a repeat): then its failure fails intake.
    const block = noteBlock(n, origin);
    const [evt, act] = await Promise.allSettled([
      appendEvent("contact", contact.id, { by: ctx.by, origin: "hook", action: "intake", wv: contact.wv, source: n.source.source, intake_origin: origin, ...(block ? { note: block } : {}) }, opts),
      addActivity(contact.id, "lead.intake", contact.id, now(), opts),
    ]);
    if (act.status === "rejected") console.error(`crm:intake: timeline row not written (${safeErr(act.reason)})`);
    if (evt.status === "rejected") {
      console.error(`crm:intake: intake event not written (${safeErr(evt.reason)})`);
      if (!created && !changed) throw evt.reason;
    }

    // 7. a new lead: one enrollment and lead.created (giveaway entries: tags
    // only). A contact that was not a lead counts when this submission changed
    // its record; a repeat of the same words changes nothing and enrolls nothing.
    const out = { ok: true, contact_id: contact.id, created, ...(evt.status === "fulfilled" ? { event: evt.value } : {}) };
    const newLead = !TAGS_ONLY.has(origin) && (created || (!wasLead && changed && contact.lifecycle !== "archived"));
    if (newLead) {
      if (has("sales.enroll")) {
        try {
          const enrollment = await call("sales.enroll", contact.id, "new_lead", {}, ctx);
          if (enrollment) out.enrollment_id = typeof enrollment === "string" ? enrollment : enrollment.id || null;
        } catch (e) {
          console.error(`crm:intake: enrollment not started (${safeErr(e)})`);
        }
      }
      await emit("lead.created", { id: contact.id, wv: contact.wv, contact_id: contact.id, origin, source: n.source.source }, ctx)
        .catch((e) => console.error(`crm:intake: lead.created not queued (${safeErr(e)})`));
    }
    return out;
  } catch (e) {
    console.error(`crm:intake: failed (${safeErr(e)})`);
    return { ok: false, created: false, error: keySafe((e && (e.code || e.name)) || "failed", 40) };
  } finally {
    if (lease) await releaseLease(lease, holder, opts);
  }
}

// The contacts.intake service: (input, { origin, rotor? }, ctx).
export const intakeService = (input, o = {}, ctx = {}) => intakeLead(input, { origin: o.origin || "app", rotor: o.rotor || null, by: ctx.by, mode: ctx.mode, requestId: ctx.requestId });
