// Test helper: a made-up office dashboard snapshot (the shape
// build/office_dashboard.mjs builds from Rotor's reports, docs/DASHBOARD.md)
// for Home's numbers, and the same sealed for a throwaway key. Synthetic
// only: round, invented amounts of a small window-cleaning company's year
// (slow winters, busy spring and fall, Christmas lights in Nov-Dec), no
// people.
//
//   syntheticRaw("2026-11-16")              raw report results, Rotor's shapes
//   syntheticSnapshot("2026-11-16")         buildSnapshot(raw)
//   sealedSnapshot(privateKeyB64, asOf)     the snapshot sealed for that key's public half

import crypto from "node:crypto";

const office = await import("../../netlify/lib/office-data.mjs");
const { buildSnapshot } = await import("../../build/office_dashboard.mjs");

// dollars collected per calendar month (Jan..Dec), this year and the one before
const MONTHLY = [2100, 1500, 3900, 14200, 21600, 19800, 15400, 16900, 18300, 22700, 19600, 11800];
const MONTHLY_PREV = [1700, 1200, 3100, 11300, 17900, 16400, 12500, 13800, 14600, 18200, 15100, 9200];
const pad = (n) => String(n).padStart(2, "0");
const addDays = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const monday = (date) => addDays(date, -((new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7));
const cents = (d) => Math.round(d * 100);

export function syntheticRaw(asOf = "2026-11-16") {
  const y = Number(asOf.slice(0, 4)), m = Number(asOf.slice(5, 7)), day = Number(asOf.slice(8, 10));
  const months = [];
  for (let i = 11; i >= 0; i--) { const mm = ((m - 1 - i) % 12 + 12) % 12; const yy = y + Math.floor((m - 1 - i) / 12); months.push({ y: yy, m: mm + 1 }); }
  const share = day / 30;
  const val = (yy, mm, prev = false) => {
    const base = (prev ? MONTHLY_PREV : MONTHLY)[mm - 1];
    return yy === y && mm === m ? Math.round(base * share) : base;
  };
  const bucket = (yy, mm, dollars) => ({ key: `${yy}-${pad(mm)}`, count: Math.max(1, Math.round(dollars / 330)), sum_cents: cents(dollars) });
  const ytd = MONTHLY.slice(0, m - 1).reduce((a, b) => a + b, 0) + Math.round(MONTHLY[m - 1] * share);
  const ytdPrev = MONTHLY_PREV.slice(0, m - 1).reduce((a, b) => a + b, 0) + Math.round(MONTHLY_PREV[m - 1] * share);
  const weeks = Array.from({ length: 12 }, (_, i) => addDays(monday(asOf), (i - 11) * 7));
  const WEEKLY = [4180, 3620, 5210, 4440, 3970, 6120, 5480, 4710, 5930, 4890, 4320, 0];
  const LEADS = [11, 9, 14, 12, 8, 15, 13, 10, 16, 12, 9, 0];
  const lastDays = Math.round((Date.parse(asOf) - Date.parse(weeks[11])) / 86400000) + 1;
  WEEKLY[11] = Math.round(780 * lastDays);
  LEADS[11] = Math.max(1, 2 * lastDays);
  const plans = [];
  const FREQ = [["Semi-Annual", 640, 34], ["Quarterly", 1180, 21], ["Monthly", 2400, 4], ["Annual", 1450, 13], ["One-Time", 320, 18]];
  let n = 0;
  for (const [f, v, count] of FREQ) for (let i = 0; i < count; i++) plans.push({ service_frequency: f, sale_value: v + (i % 5) * 40, sold_by: ["u1", "u2", "u3"][n++ % 3] });
  return {
    as_of: asOf,
    payments_by_month: { buckets: months.map(({ y: yy, m: mm }) => bucket(yy, mm, val(yy, mm))) },
    payments_by_month_prev: { buckets: months.map(({ y: yy, m: mm }) => bucket(yy - 1, mm, val(yy, mm, true))) },
    payments_ytd_by_type: { buckets: [{ key: "invoice", count: Math.round(ytd / 330), sum_cents: cents(ytd) }, { key: "refund", count: 2, sum_cents: 18000 }] },
    payments_ytd_by_type_prev: { buckets: [{ key: "invoice", count: Math.round(ytdPrev / 320), sum_cents: cents(ytdPrev) }] },
    payments_by_week: { buckets: weeks.map((k, i) => ({ key: k, count: Math.max(1, Math.round(WEEKLY[i] / 330)), sum_cents: cents(WEEKLY[i]) })) },
    leads_by_week: { buckets: weeks.map((k, i) => ({ key: k, count: LEADS[i] })) },
    leads_by_source: { totals: { count: 412 }, buckets: [{ key: "Website quote form", count: 188 }, { key: "Meta Ads", count: 104 }, { key: "Referral Program", count: 61 }, { key: "Google", count: 39 }, { key: "Yard Sign", count: 20 }] },
    customers_by_source: { buckets: [{ key: "Website quote form", count: 96 }, { key: "Referral", count: 44 }, { key: "Meta Ads", count: 38 }, { key: "Door Hanger", count: 12 }, { key: "Returning Customer", count: 300 }] },
    invoices_by_status: { buckets: [{ key: "draft", count: 3, sum_cents: 104000 }, { key: "overdue", count: 2, sum_cents: 61000 }, { key: "sent", count: 9, sum_cents: 297000 }, { key: "paid", count: 402, sum_cents: cents(ytd) }] },
    jobs_by_status: { buckets: [{ key: "Pending", count: 17 }, { key: "Scheduled", count: 58 }, { key: "In Progress", count: 2 }, { key: "Completed", count: 431 }, { key: "Cancelled", count: 19 }] },
    visits_by_month: { buckets: months.map(({ y: yy, m: mm }) => ({ key: `${yy}-${pad(mm)}`, count: Math.max(4, Math.round(val(yy, mm) / 310)) })) },
    visits_next_weeks: { buckets: [0, 1, 2, 3].map((i) => ({ key: addDays(monday(asOf), i * 7), count: [31, 26, 19, 14][i] })) },
    plans_created_by_month: { buckets: months.slice(-4).map(({ y: yy, m: mm }, i) => ({ key: `${yy}-${pad(mm)}`, count: [9, 14, 11, 6][i] })) },
    plan_cancellations: { totals: { count: 4 } },
    quotes_by_status: { draft: 6, sent: 14, approved: 3, converted: 41, rejected: 22, modification_requested: 2 },
    members: [{ user_id: "u1", name: "Olive Owner" }, { user_id: "u2", name: "Ada Admin" }, { user_id: "u3", name: "Theo Tech" }],
    service_plans_active: { data: plans },
  };
}

export const syntheticSnapshot = (asOf = "2026-11-16") => buildSnapshot(syntheticRaw(asOf));

// The snapshot sealed for the public half of an OFFICE_DATA_KEY (44 characters of base64).
export function sealedSnapshot(privateKeyB64, asOf = "2026-11-16", snap = syntheticSnapshot(asOf)) {
  const priv = office.privateKey({ OFFICE_DATA_KEY: privateKeyB64 });
  if (!priv || priv === "bad") throw new Error("sealedSnapshot needs a 32-byte key");
  const pem = crypto.createPublicKey(priv).export({ format: "pem", type: "spki" });
  return office.seal(snap, pem);
}
