// Every CRM module, registered at cold start (design §11.2, §11.3). Core
// file, created in M1.1 (map, the door-to-door and team maps, added after
// M8: docs/CRM-MAP.md): a module plugs in through
// its own manifest (types, settings, permissions, routes, sweeps, services,
// ...). Importing this file registers them all; the registry rejects an
// invalid manifest at import time, so a bad module fails `npm test`.

import { registerModules } from "../core/registry.mjs";
import system from "./system/index.mjs";
import contacts from "./contacts/index.mjs";
import sales from "./sales/index.mjs";
import importMod from "./import/index.mjs";
import quotes from "./quotes/index.mjs";
import plans from "./plans/index.mjs";
import work from "./work/index.mjs";
import money from "./money/index.mjs";
import comms from "./comms/index.mjs";
import payroll from "./payroll/index.mjs";
import reports from "./reports/index.mjs";
import mcp from "./mcp/index.mjs";
import map from "./map/index.mjs";

export const MODULES = Object.freeze([system, contacts, sales, importMod, quotes, plans, work, money, comms, payroll, reports, mcp, map]);
registerModules(MODULES);
export default MODULES;
