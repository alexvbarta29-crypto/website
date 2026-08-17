// Receives quote-form submissions from the site (POSTed as JSON by
// assets/js/main.js — see docs/LEAD-FORM-SETUP.md) and creates or updates a
// lead in Rotor CRM via its open API. Rotor upserts by phone first, then
// email, and merges tags on update, so repeat submissions from the same
// visitor enrich one lead instead of duplicating it.
//
// The Rotor API key lives ONLY in the ROTOR_API_KEY environment variable set
// in the Netlify dashboard (Site configuration → Environment variables). It
// must never appear in this repo or in the static pages.

const ROTOR_URL = "https://api.getrotor.com/open-api/leads";
const MAX_FIELD = 500;

const clean = (v) => (typeof v === "string" ? v.trim().slice(0, MAX_FIELD) : "");

export default async (req) => {
  if (req.method !== "POST")
    return Response.json({ error: "Method not allowed" }, { status: 405 });

  const key = process.env.ROTOR_API_KEY;
  if (!key) {
    console.error("ROTOR_API_KEY is not set — lead dropped");
    return Response.json({ error: "Lead endpoint not configured" }, { status: 500 });
  }

  let data;
  try { data = await req.json(); } catch { data = null; }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return Response.json({ error: "Invalid body" }, { status: 400 });

  const name = clean(data.name) ||
    [clean(data.first_name), clean(data.last_name)].filter(Boolean).join(" ");
  const phone = clean(data.phone);
  const email = clean(data.email);
  // Without phone or email the lead is uncontactable (and Rotor has nothing
  // to upsert on); the forms require phone, so only hand-crafted requests
  // ever hit this.
  if (!phone && !email)
    return Response.json({ error: "Phone or email required" }, { status: 400 });

  const address = clean(data.address) ||
    [clean(data.address_street), clean(data.address_city),
     clean(data.address_state), clean(data.address_zip)]
      .filter(Boolean).join(", ");

  const services = Array.isArray(data.services)
    ? data.services.map(clean).filter(Boolean).slice(0, 20) : [];
  const plan = clean(data.plan || data.plan_choice);
  const tags = ["website-lead", ...services, ...(plan ? ["plan: " + plan] : [])];

  // Every answer the visitor gave, as one readable block — so nothing is
  // lost even where Rotor has no matching structured field for it.
  const skip = new Set(["access_key", "subject", "address_verified"]);
  const notes = Object.entries(data)
    .filter(([k, v]) => !skip.has(k) && v != null && v !== "")
    .map(([k, v]) => k + ": " + (Array.isArray(v) ? v.map(clean).join(", ") : clean(String(v))))
    .join("\n");

  const res = await fetch(ROTOR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ name, phone, email, address, tags,
                           source: "Website quote form", notes }),
  });

  // 201 = new lead, 200 = existing lead updated. Anything else must NOT look
  // like success to the visitor — main.js only shows the success screen on
  // 2xx and falls back to phone/email otherwise.
  if (res.status !== 200 && res.status !== 201) {
    console.error("Rotor rejected lead:", res.status, await res.text());
    return Response.json({ error: "Upstream error" }, { status: 502 });
  }
  return Response.json({ ok: true });
};

export const config = { path: "/api/lead" };
