// The work module's tracking part (docs/CRM-WORK.md "Tracking link"):
// On my way's short link to an "on the way" page. Composed by
// work/index.mjs as a part, like field.mjs.
//
//   cfg/tracking (settings:general): { enabled, show_vehicle, vehicles:
//     { user id: "White Ford Transit" }, location_minutes (120) }
//   template on_my_way_track: the On my way text with the link
//   GET /p/track/:code            the page (no cookie: the code is the key)
//   GET /api/portal/track/:code   what the page polls while the tech is on the way
//
// visit-actions.mjs calls trackLinkFor() when a tech taps On my way; what
// the page shows and hides lives in portal/track.mjs.

import { InputError } from "../../core/errors.mjs";
import { isId } from "../../core/ids.mjs";
import { isPlainObject } from "../../core/validate.mjs";
import { getSetting } from "../../../crm-store.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { TRACK_DEFAULTS, createTrackLink, trackState, trackPage, isTrackCode, ENDED } from "../../portal/track.mjs";

export const TRACK_TEMPLATE = "on_my_way_track";

// Templates in Barta's voice (barta-rules §8): no "Reply STOP" (the sender
// adds the opt-out footer, D5), no em dashes. The link rides in portal_link.
export const TRACK_TEMPLATES = [
  { key: TRACK_TEMPLATE, name: "On my way (with the tracking link)", channel: "sms", category: "service",
    body: "Hi {{first_name|there}}, it's {{tech_first_name}} with {{company_name}}. I'm on my way and should be there in about {{eta_minutes}} minutes. Follow along here: {{portal_link}}" },
];

export function validateTracking(v) {
  const src = isPlainObject(v) ? v : {};
  const out = {};
  for (const k of ["enabled", "show_vehicle"]) {
    if (src[k] === undefined) continue;
    if (typeof src[k] !== "boolean") throw new InputError("Yes or no.", k);
    out[k] = src[k];
  }
  if (src.location_minutes !== undefined) {
    if (!Number.isInteger(src.location_minutes) || src.location_minutes < 15 || src.location_minutes > 240) throw new InputError("Use minutes from 15 to 240.", "location_minutes");
    out.location_minutes = src.location_minutes;
  }
  if (src.vehicles !== undefined) {
    if (!isPlainObject(src.vehicles)) throw new InputError("Expected a vehicle per person.", "vehicles");
    out.vehicles = {};
    for (const [uid, text] of Object.entries(src.vehicles).slice(0, 40)) {
      if (!isId(uid, "user")) throw new InputError("A vehicle belongs to someone on the team.", "vehicles");
      const t = String(text ?? "").replace(/\s+/g, " ").trim();
      if (t.length > 60) throw new InputError("Keep it short, like \"a white Ford Transit\".", `vehicles.${uid}`);
      if (/[<>]/.test(t)) throw new InputError("Plain words only.", `vehicles.${uid}`);
      if (t) out.vehicles[uid] = t;
    }
  }
  return out;
}

// The link for one On my way tap. → { code, url } | null (links off, or storage failed: the text goes without it)
export async function trackLinkFor({ visit, userId, at, tapKey }) {
  try {
    const settings = await getSetting("tracking");
    return await createTrackLink({ visit, userId, at, tapKey, settings });
  } catch (e) {
    console.error(`crm:work: no tracking link (${safeErr(e)})`);
    return null;
  }
}

const pageOf = async (p) => {
  const code = p.params.code;
  if (!isTrackCode(code)) return p.message("That link isn't right", "Check the link in your text, or call us.", { status: 404, company: p.company });
  const view = await trackState(code);
  if (view.missing) return p.message("That link isn't right", "Check the link in your text, or call us.", { status: 404, company: p.company });
  if (view.ended) return p.message(ENDED[0], ENDED[1], { status: 410, company: p.company });
  const { title, body } = trackPage(code, view);
  return p.portalPage(p.layout({ title, body, script: "track.js", company: p.company, page: "track" }));
};

const dataOf = async (p) => {
  const code = p.params.code;
  if (!isTrackCode(code)) return p.fail("missing", "That link isn't right.", 404);
  const view = await trackState(code);
  if (view.missing) return p.fail("missing", "That link isn't right.", 404);
  if (view.ended) return p.fail("ended", ENDED.join(". "), 410);
  return p.json({ ok: true, data: view });
};

export default {
  settings: { tracking: { defaults: { ...TRACK_DEFAULTS }, validate: validateTracking, perm: "settings:general" } },
  templates: TRACK_TEMPLATES,
  portalRoutes: [
    { method: "GET", path: "/p/track/:code", scope: "public", handler: pageOf },
    { method: "GET", path: "/api/portal/track/:code", scope: "public", handler: dataOf },
  ],
};
