// Every module's client manifest, in one list the router and the nav read
// (design §2.3, §11.3). Core file: created in M1.1 with a stub per module;
// a module track edits only its own manifest.js, never this list.

import system from "./system/manifest.js";
import contacts from "./contacts/manifest.js";
import sales from "./sales/manifest.js";
import importMod from "./import/manifest.js";
import quotes from "./quotes/manifest.js";
import plans from "./plans/manifest.js";
import work from "./work/manifest.js";
import money from "./money/manifest.js";
import comms from "./comms/manifest.js";
import payroll from "./payroll/manifest.js";
import reports from "./reports/manifest.js";
import mcp from "./mcp/manifest.js";
import map from "./map/manifest.js";

export const MANIFESTS = Object.freeze([system, contacts, sales, importMod, quotes, plans, work, money, comms, payroll, reports, mcp, map]);
export default MANIFESTS;
