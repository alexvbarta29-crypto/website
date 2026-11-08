// GET /dashboard — Barta Office's KPI dashboards (docs/DASHBOARD.md). Signed in
// with the one office password only; the numbers are opened from the sealed
// Rotor snapshot on the server and never cached.

import { signedIn, toOffice } from "../lib/lights-auth.mjs";
import { loadDashboard } from "../lib/office-data.mjs";
import { dashboardHtml, setupHtml } from "../lib/dashboard-page.mjs";

export const config = { path: ["/dashboard", "/dashboard/"] };

const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "SAMEORIGIN",
};

export default async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  if (!signedIn(req)) return toOffice("dashboard");
  const got = loadDashboard();
  return new Response(got.ok ? dashboardHtml(got.data) : setupHtml(got.reason), { status: 200, headers });
};
