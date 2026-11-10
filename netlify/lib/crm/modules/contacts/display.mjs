// Contacts module: how a person, a phone, an email and an address are
// written and shown (design §5.1, §3.15, §12.2 "contacts").
//
// Pure functions only (no store, no clock), so the API, the import, the
// intake, the legacy Customers list (crm-data.mjs re-exports the first
// slice's helpers from here) and the tests all share one spelling of a name
// or a number. Moved here from crm-data.mjs and build/crm_seal_import.mjs in
// M2a: tidy, displayName, sortName, initial, customersSorted, phoneDigits,
// phoneFormatted, addressLines, addressText, city, mapsUrl, sinceLabel,
// fixMojibake. New here: E.164 normalization with the import's 12-digit and
// junk cases, email normalization, address normalization (state from ZIP),
// the contacts index row's search text and the service-area tier.

const str = (v) => (v == null ? "" : String(v)).trim();
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
export const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

// ------------------------------------------------------------ names (first slice)

// Display only: a name typed all in lower case ("pat zimmer") gets its
// capitals back. Anything with a capital in it is left exactly as entered.
export const tidy = (s) => (s && !/\p{Lu}/u.test(s) ? s.replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1)) : s);

// "First Last", else the company, else a placeholder: never an empty row.
export function displayName(c) {
  return [tidy(str(c && c.first_name)), tidy(str(c && c.last_name))].filter(Boolean).join(" ") || str(c && c.company_name) || "No name";
}

// The name a list is alphabetised by: the last name, falling back to the
// first name and then the company. Leading punctuation ("& Dan Baker" for a
// couple) is skipped so the row still lands under a letter.
export function sortName(c) {
  const last = str(c && c.last_name).replace(/^[^\p{L}\p{N}]+/u, "");
  return last || str(c && c.first_name).replace(/^[^\p{L}\p{N}]+/u, "") || str(c && c.company_name);
}

// The letter heading a person sits under: A–Z, or # for anything else.
export function initial(c) {
  const ch = sortName(c).charAt(0).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  return /^[A-Z]$/.test(ch) ? ch : "#";
}

// By last name, then first name, then company. # sorts last.
export function customersSorted(customers) {
  const keys = (c) => [initial(c) === "#" ? "￿" : "", sortName(c), str(c.first_name), str(c.company_name)];
  return [...customers].sort((a, b) => {
    const ka = keys(a), kb = keys(b);
    for (let i = 0; i < ka.length; i++) { const r = collator.compare(ka[i], kb[i]); if (r) return r; }
    return 0;
  });
}

// A first name as matching compares it: lower case, letters only, no accents.
export const normName = (s) => str(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

// Names Rotor handed back double-encoded ("OÃ¢â‚¬â„¢Connor" style): re-read
// as UTF-8 when that gives clean text, else left as they are.
export function fixMojibake(s) {
  if (typeof s !== "string" || !/[Â-ô][\u0080-¿]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s;
  const fixed = Buffer.from(s, "latin1").toString("utf8");
  return fixed.includes("�") ? s : fixed;
}

// ------------------------------------------------------------ phones

// "+17633143400" → "7633143400"; anything that isn't a US number keeps its digits.
export function phoneDigits(raw) {
  let d = str(raw).replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  return d;
}

// "(763) 314-3400" for a 10-digit number, else whatever was typed.
export function phoneFormatted(raw) {
  const d = phoneDigits(raw);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : str(raw);
}

// A US phone in E.164, with the reasons the import reports when it can't be
// one: { e164 } | { e164: null, problem: "empty" | "twelve_digits" | "junk" }.
// "Junk" is anything that is not a valid North American number: too short,
// an area code or exchange starting 0 or 1, or one digit repeated.
export function normalizePhone(raw) {
  const d0 = str(raw).replace(/\D/g, "");
  if (!d0) return { e164: null, problem: "empty" };
  let d = d0;
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  if (d.length === 12) return { e164: null, problem: "twelve_digits" };
  if (d.length !== 10 || !/^[2-9]\d{2}[2-9]\d{6}$/.test(d) || /^(\d)\1{9}$/.test(d)) return { e164: null, problem: "junk" };
  return { e164: "+1" + d };
}
export const toE164 = (raw) => normalizePhone(raw).e164;

// ------------------------------------------------------------ emails

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;
// A trimmed, lower-cased email, or null when it isn't one.
export function normalizeEmail(raw) {
  const s = str(raw).toLowerCase();
  return s && s.length <= 120 && EMAIL_RE.test(s) ? s : null;
}

// ------------------------------------------------------------ addresses

// The three-digit ZIP prefixes of Minnesota (550-567): a junk state on a
// row whose ZIP is clearly Minnesotan is repaired to MN (§10.2 row 6).
const MN_ZIP = /^(55[0-9]|56[0-7])\d{2}$/;
const STATE_RE = /^[A-Z]{2}$/;
export const STATE_NAMES = Object.freeze({ MINNESOTA: "MN", WISCONSIN: "WI", IOWA: "IA", "NORTH DAKOTA": "ND", "SOUTH DAKOTA": "SD" });

// { street1, street2?, city, state, zip, country: "US" } from the many shapes
// addresses arrive in (Rotor rows, website forms, the app), or null when
// nothing usable is there. `repaired` lists what was fixed (the report).
export function normalizeAddress(a, { repaired } = {}) {
  if (!plain(a)) return null;
  const street1 = str(a.street1 ?? a.street ?? a.address_street1 ?? a.line1).slice(0, 200);
  const street2 = str(a.street2 ?? a.address_street2 ?? a.line2).slice(0, 200);
  const city = str(a.city ?? a.address_city).slice(0, 60);
  let zip = str(a.zip ?? a.zip_code ?? a.postal_code ?? a.address_zip).replace(/\s+/g, "").slice(0, 10);
  if (/^\d{9}$/.test(zip)) zip = zip.slice(0, 5) + "-" + zip.slice(5);
  let state = str(a.state ?? a.address_state).toUpperCase();
  if (STATE_NAMES[state]) state = STATE_NAMES[state];
  if (!STATE_RE.test(state)) {
    const fixed = MN_ZIP.test(zip.slice(0, 5)) ? "MN" : "";
    if (repaired && (state || fixed)) repaired.push("state");
    state = fixed;
  } else if (state !== "MN" && MN_ZIP.test(zip.slice(0, 5)) && repaired) {
    // a Minnesota ZIP with another state: keep what was typed, the report lists it
    repaired.push("state_zip_mismatch");
  }
  if (!street1 && !city && !zip) return null;
  const out = { street1, city, state: state || "MN", zip, country: "US" };
  if (street2) out.street2 = street2;
  return out;
}

// One line, for a search row or a maps link: "100 Example Ave, Delano, MN 55328".
export function addressOneLine(a) {
  if (!plain(a)) return "";
  const street = [str(a.street1), str(a.street2)].filter(Boolean).join(", ");
  const town = [[str(a.city), str(a.state)].filter(Boolean).join(", "), str(a.zip)].filter(Boolean).join(" ");
  return [street, town].filter(Boolean).join(", ");
}

// "100 example ave--55328": how two addresses are compared (street + ZIP).
export function addressKey(a) {
  if (!plain(a)) return "";
  const street = str(a.street1).toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\b(street)\b/g, "st").replace(/\b(avenue)\b/g, "ave").replace(/\b(road)\b/g, "rd").replace(/\b(drive)\b/g, "dr")
    .replace(/\b(lane)\b/g, "ln").replace(/\b(court)\b/g, "ct").replace(/\b(circle)\b/g, "cir").replace(/\b(boulevard)\b/g, "blvd")
    .replace(/\b(north)\b/g, "n").replace(/\b(south)\b/g, "s").replace(/\b(east)\b/g, "e").replace(/\b(west)\b/g, "w")
    .replace(/\s+/g, " ").trim();
  return street ? `${street}--${str(a.zip).slice(0, 5)}` : "";
}

// ["100 Example Ave", "Delano, MN 55328"] of a first-slice row ({ address }),
// dropping whatever is missing.
export function addressLines(c) {
  const a = c && c.address;
  if (!a) return [];
  if (typeof a === "string") return a.split(/\s*[\n,]\s*/).map((s) => s.trim()).filter(Boolean);
  const street = [str(a.street1), str(a.street2)].filter(Boolean).join(", ");
  const cityState = [str(a.city), str(a.state)].filter(Boolean).join(", ");
  const town = [cityState, str(a.zip)].filter(Boolean).join(" ");
  return [street, town].filter(Boolean);
}

export const addressText = (c) => addressLines(c).join(", ");

// The town shown on the right of a row.
export function city(c) {
  const a = c && c.address;
  return a && typeof a === "object" ? str(a.city) : "";
}

// Apple Maps opens this on an iPhone; everywhere else it redirects to a web
// map. Empty when there's no address to send.
export function mapsUrl(c) {
  const q = addressText(c);
  return q ? "https://maps.apple.com/?q=" + encodeURIComponent(q) : "";
}

// "Mar 2025" (company time zone) from an ISO timestamp; "" if unreadable.
export function sinceLabel(iso) {
  const d = new Date(iso || "");
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "America/Chicago" });
}

// "Nov 17, 2026" in the company's time zone (a note block's heading).
const DATE_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
export const dateLabel = (d) => { const x = d instanceof Date ? d : new Date(d); return Number.isNaN(x.getTime()) ? "" : DATE_FMT.format(x); };

// ------------------------------------------------------------ the service area (§5.1, §6.5)

const R_MI = 3958.7613;
const rad = (x) => (x * Math.PI) / 180;
// Great-circle miles between two { lat, lng }.
export function haversineMi(a, b) {
  if (!a || !b || ![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) return null;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

// EXTENDED_FACTOR: up to a quarter past the radius is "extended" (we go there
// for the right job); beyond that is "outside" and only ever flagged for a
// person to check, never refused (§5.1 "never an automatic reject").
export const EXTENDED_FACTOR = 1.25;
// → { town_tier, distance_mi? } from a geocode (or none) and cfg/service_area.
export function areaTier({ geo, city: town } = {}, area = {}) {
  const center = area.center || { lat: 45.0419, lng: -93.7891 };
  const radius = Number.isFinite(area.radius_mi) ? area.radius_mi : 20;
  const towns = Array.isArray(area.towns) ? area.towns.map((t) => normName(t)) : [];
  const d = geo ? haversineMi(center, geo) : null;
  if (d === null) return { town_tier: town && towns.includes(normName(town)) ? "primary" : "unknown" };
  const distance_mi = Math.round(d * 10) / 10;
  if (d <= radius) return { town_tier: "primary", distance_mi };
  if (d <= radius * EXTENDED_FACTOR) return { town_tier: "extended", distance_mi };
  return { town_tier: "outside", distance_mi };
}

// ------------------------------------------------------------ lifecycle words

export const LIFECYCLE_LABELS = Object.freeze({ lead: "Lead", customer: "Customer", former_customer: "Former customer", archived: "Archived" });
