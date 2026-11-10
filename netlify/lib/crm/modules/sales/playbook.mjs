// Sales module: the office Follow-ups page (/playbook) shows the CRM's
// cadence wording (design §11.4 M2b, docs/OFFICE.md).
//
// netlify/functions/playbook.mjs serves the playbook page as it always has;
// when the CRM is set up and its templates cad_new_1..9 / cad_est_1..5 are
// there, it asks playbookHtml() for the page with those texts swapped in,
// so an owner who edits a follow-up text in Settings → Templates sees the
// same words on the Follow-ups page. Anything else (the CRM not set up, no
// store on this deploy, a slow or failing read, a template missing) keeps
// the built-in text. Nothing here ever throws or delays the page more than
// READ_MS.
//
// The CRM's {{variables}} become the playbook's fill-ins: {{first_name}} →
// {first}, {{sender_first_name}} → {rep}, {{company_name}} → {co},
// {{review_count}} → {reviews}, {{review_link}} → {link}; any other
// variable shows its fallback (or a [Label] to fill in).

import { PLAYBOOK_HTML } from "../../../playbook-page.mjs";
import { crmDeploy } from "../contacts/hook.mjs";

export const READ_MS = 1500;
export const CACHE_MS = 60 * 1000;
export const KEYS = Object.freeze([...Array.from({ length: 9 }, (_, i) => `cad_new_${i + 1}`), ...Array.from({ length: 5 }, (_, i) => `cad_est_${i + 1}`)]);

// The page's built-in texts, exactly as playbook-page.mjs holds them.
export const BUILT_IN = Object.freeze({
  cad_new_1: "Hey {first}! This is {rep} with {co}. I saw you requested a quote to get your windows cleaned. Give me a ring back whenever you get a sec and I'd love to get you that free quote. Have a great day!",
  cad_new_2: "Hey {first}, just missed you again! In case it helps while we're playing a little phone tag, here are our reviews. We've got over {reviews} 5 star ratings you can read through: {link}",
  cad_new_3: "Hey it's {rep}, kept missing you today! No rush at all, I'll try you again tomorrow to get you that free quote. I'd really love to connect so I can make sure I get you the most accurate price for your home. Talk soon!",
  cad_new_4: "Good morning {first}! This is {rep} with {co}. I gave you a quick call to get you that quote on your windows but didn't catch you. I'll be around all day, so whenever you get a free minute just call me back. Thanks so much!",
  cad_new_5: "Hey, just missed you again! You're probably getting a few other quotes, so here's a few pointers for how to find the right person for the job. 1) fully licensed and insured so you and your property are protected, 2) frames and sills included, not just the glass, and 3) a 100% satisfaction guarantee. PS we do all of those things!",
  cad_new_6: "Hey {first}, wasn't able to reach you today but I'll give you another call tomorrow morning to get you that quote. If now's just not the best time, no worries at all, just let me know what works! Have a wonderful evening.",
  cad_new_7: "Hey {first}, I know I've reached out a few times, and I know you're busy! I just don't want to leave you hanging on that quote you requested. It would only be like a 5 min call.",
  cad_new_8: "Hey, missed you again today! Real quick, one thing I love about us is our 100% satisfaction guarantee. If you're ever not happy with the job we'll come back and make it right free of charge, and if you're still not happy we'll refund you. So there's truly no risk on your end. Would love to get you that quote whenever you're free!",
  cad_new_9: "Hey {first}, since we keep missing each other, I'll go ahead and put your quote together and send it right over. Take a look when you get a sec and let me know what you think! Happy to answer any questions.",
  cad_est_1: "Hey {first}, it's {rep} with {co}. Just wanted to make sure you got everything you need on your window cleaning estimate. If any questions came up, I'm happy to walk through them. Want me to go ahead and find you a spot on the schedule?",
  cad_est_2: "Hey {first}, one more thing! Our schedule's been filling up fast lately, so if you're leaning toward getting your windows done I'd hate for you to have to wait. Just send me a day that works and I'll hold a spot for you. No pressure either way!",
  cad_est_3: "Hey {first}! Good news, I was able to take $50 off your estimate to help make this an easy yes for you. That price is good whenever you're ready to book, just send me a day that works and I'll get you locked in!",
  cad_est_4: "Hey {first}! Wanted to sweeten the deal one more time. On top of the $50 off your estimate, if you book today we can also clean 10 screens for free for you. Just let me know a day that works and I'll lock it all in for you!",
  cad_est_5: "Hey {first}, since I haven't heard back I'm going to go ahead and archive your quote, which means the $50 off and free screen cleaning will expire. If you still want to get your windows done, just let me know asap and I can get you taken care of before those discounts are gone. Otherwise no worries at all, just reach out whenever you're ready!",
});

// How a text sits in the page's script: a single-quoted JS string.
export const jsLiteral = (s) => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
// A replacement that is safe in the inline script: JSON, with < and the
// two line separators escaped (no "</script>" can close the block).
const safeLiteral = (s) => JSON.stringify(String(s)).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const FILL = { first_name: "{first}", sender_first_name: "{rep}", company_name: "{co}", review_count: "{reviews}", review_link: "{link}" };
const LABELS = { last_name: "Last Name", full_name: "Full Name", town: "Town", company_phone: "Company Phone", quote_link: "Quote Link", portal_link: "Portal Link" };

// A CRM template body → the playbook's fill-in syntax (pure).
export function toPlaybookText(body) {
  return String(body || "")
    .replace(/\{\{\s*([a-z_]+)\s*(?:\|([^{}]*))?\}\}/gi, (_, name, fallback) => {
      const k = name.toLowerCase();
      if (FILL[k]) return FILL[k];
      if (fallback !== undefined) return fallback.trim();
      return `[${LABELS[k] || k.replace(/_/g, " ")}]`;
    })
    // a single brace left in the words would read as a fill-in on the page
    .replace(/\{(?!first\}|rep\}|co\}|reviews\}|link\})/g, "(")
    .slice(0, 1600);
}

// The page with the given texts ({ key: playbook text }) in place of the
// built-in ones (pure). Keys not given, or not found, stay as they are.
export function withTexts(html, texts = {}) {
  let out = html;
  for (const key of KEYS) {
    const want = texts[key];
    if (typeof want !== "string" || !want.trim() || want === BUILT_IN[key]) continue;
    const lit = jsLiteral(BUILT_IN[key]);
    if (!out.includes(lit)) continue;
    out = out.replace(lit, () => safeLiteral(want));
  }
  return out;
}

let cache = null;   // { at, texts }
export function clearPlaybookCache() { cache = null; }

const timeout = (p, ms) => Promise.race([p, new Promise((resolve) => { const t = setTimeout(() => resolve(null), ms); t.unref?.(); })]);

// The CRM's cadence texts in playbook syntax, or null (not set up, no store,
// nothing there, too slow). Reads the templates index and the 14 records.
export async function crmTexts(req, context, env = process.env) {
  const deploy = crmDeploy(req, context, env);
  if (!deploy) return null;
  const t = performance.now();
  if (cache && t - cache.at < CACHE_MS) return cache.texts;
  try {
    const store = await import("../../../crm-store.mjs");
    const read = store.withStoreScope({ deploy, budget: store.withBudget(READ_MS, 20, { strict: false }), requestId: "playbook" }, async () => {
      const ix = await store.readIndex("templates", "");
      const rows = ix.rows.filter((r) => KEYS.includes(r.k));
      if (!rows.length) return {};
      const got = await store.getRecords("template", rows.map((r) => r.id));
      const out = {};
      for (const g of got) {
        const d = g && g.data;
        if (!d || d.deleted_at || !KEYS.includes(d.key) || typeof d.body !== "string") continue;
        out[d.key] = toPlaybookText(d.body);
      }
      return out;
    });
    const texts = await timeout(read, READ_MS + 200);
    if (!texts) return null;
    cache = { at: performance.now(), texts };
    return texts;
  } catch (e) {
    console.error(`crm:sales: playbook texts not read (${(e && (e.code || e.name)) || "error"})`);
    return null;
  }
}

// The Follow-ups page: the CRM's wording when it has it, else the built-in page.
export async function playbookHtml(req, context, env = process.env) {
  const texts = await crmTexts(req, context, env).catch(() => null);
  return texts && Object.keys(texts).length ? withTexts(PLAYBOOK_HTML, texts) : PLAYBOOK_HTML;
}
