// /q/* — where the QR codes on Barta's yard signs, door hangers and flyers
// go (the CRM's Signs & flyers, docs/CRM-SALES.md). Counts the scan (when,
// and the rough kind of phone; never an IP address), then sends the visitor
// to the code's page of the website with the source in the address and in
// a first-party cookie the quote form's request carries to the CRM. Its own
// function so Netlify's platform rate limit sits in front of it; a printed
// sign never breaks (no setup yet, storage down: the quote page, uncounted).
import { handleScan } from "../lib/crm/modules/sales/signs-scan.mjs";
import "../lib/crm/modules/index.mjs";

export const config = {
  path: "/q/*",
  rateLimit: { windowSize: 60, windowLimit: 60, aggregateBy: ["ip", "domain"], action: "rate_limit" },
};

export default (req, context) => handleScan(req, context);
