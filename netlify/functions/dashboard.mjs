// GET /dashboard — Barta Office's KPI dashboards (docs/DASHBOARD.md). Signed in
// with the one office password only. Where the numbers come from is the
// CRM's cfg/dashboard.source (design §5.9, docs/CRM-REPORTS.md): "rotor" (the
// default until cutover) opens the sealed Rotor snapshot on the server;
// "crm" builds the same picture live from the CRM's records
// (reports.dashboardRaw → buildSnapshot, kept in memory 10 minutes). If the
// CRM can't answer, the sealed snapshot is shown, so the tab never breaks.

import { signedIn, toOffice } from "../lib/lights-auth.mjs";
import { loadDashboard } from "../lib/office-data.mjs";
import { dashboardHtml, setupHtml } from "../lib/dashboard-page.mjs";
import { deployContext } from "../lib/crm/core/context.mjs";
import { withStoreScope, withBudget, getSetting } from "../lib/crm-store.mjs";
import { storeBlocked } from "../lib/crm/core/auth.mjs";
import { nowMs, localDate, now } from "../lib/crm/core/clock.mjs";
import { safeErr } from "../lib/referral-lib.mjs";

export const config = { path: ["/dashboard", "/dashboard/"] };

const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "SAMEORIGIN",
};

export const CRM_CACHE_MS = 10 * 60 * 1000;
let memo = null;   // { at, asOf, snap }
export const __clearDashboardCache = () => { memo = null; };

// The CRM's own picture when cfg/dashboard.source is "crm"; null otherwise (or when it can't be built).
export async function crmSnapshot(req, context) {
  try {
    const deploy = deployContext(req, context);
    if (storeBlocked(deploy)) return null;
    return await withStoreScope({ deploy, budget: withBudget(9000, 320), requestId: "dashboard" }, async () => {
      await import("../lib/crm/modules/index.mjs");
      const cfg = await getSetting("dashboard").catch(() => null);
      if (!cfg || cfg.source !== "crm") return null;
      const asOf = localDate(now());
      if (memo && memo.asOf === asOf && nowMs() - memo.at < CRM_CACHE_MS) return memo.snap;
      const { dashboardRaw } = await import("../lib/crm/modules/reports/dashboard-raw.mjs");
      const { buildSnapshot } = await import("../../build/office_dashboard.mjs");
      const snap = buildSnapshot(await dashboardRaw(asOf));
      memo = { at: nowMs(), asOf, snap };
      return snap;
    });
  } catch (e) {
    console.error("dashboard: the CRM's numbers couldn't be built, showing the snapshot (" + safeErr(e) + ")");
    return null;
  }
}

export default async (req, context) => {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  if (!signedIn(req)) return toOffice("dashboard");
  const live = await crmSnapshot(req, context);
  if (live) return new Response(dashboardHtml(live), { status: 200, headers });
  const got = loadDashboard();
  return new Response(got.ok ? dashboardHtml(got.data) : setupHtml(got.reason), { status: 200, headers });
};
