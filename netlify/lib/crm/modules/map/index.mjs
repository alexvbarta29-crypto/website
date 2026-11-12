// The "map" module: door to door (the knock map: pins, pin types,
// territories, convert to lead, the canvassing report) and the live team
// map (where the people on the clock are). docs/CRM-MAP.md.
//
//   types.mjs        pin, territory; the pin types (cfg/pin_types, comms' setting) with outcomes
//   pins.mjs         the knock map's routes, convert to lead, the report
//   territories.mjs  drawn areas
//   team.mjs         location sharing while clocked in, the team map, retention
//   geocode.mjs      the Census batch geocoder (sweep) and Nominatim reverse geocoding
//   geo.mjs          point in polygon, boxes, thinning (pure)
// The map sources (OpenFreeMap, USGS aerial; swappable by env) and the CSP
// hosts are core's (core/map-sources.mjs).

import { defineModule } from "../../core/registry.mjs";
import { InputError } from "../../core/errors.mjs";
import { isId } from "../../core/ids.mjs";
import { kickWorker } from "../../core/lanes.mjs";
import { mapSources } from "../../core/map-sources.mjs";
import { listRel, getRaw } from "../../../crm-store.mjs";
import { pinType, territoryType } from "./types.mjs";
import { knockStart, places, listPins, createPin, getPin, updatePin, deletePin, convertPin, reverse, report } from "./pins.mjs";
import { listTerritories, createTerritory, getTerritory, patchTerritory, deleteTerritory } from "./territories.mjs";
import { sharingRoute, postPosition, teamMap, runRetention, forgetPositions, TEAM_DEFAULTS } from "./team.mjs";
import { runCensusGeocode, geocodeModes, STATE_KEY } from "./geocode.mjs";

export const MAP_DEFAULTS = Object.freeze({
  team_map: { ...TEAM_DEFAULTS },
  geocoding: { batch: "census", reverse: "nominatim" },
});

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const intIn = (v, min, max, def, f) => {
  if (v === undefined || v === null) return def;
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new InputError(`Pick a number from ${min} to ${max}.`, f);
  return v;
};
export function validateMap(v) {
  const tm = isObj(v && v.team_map) ? v.team_map : {};
  const people = Array.isArray(tm.people) ? tm.people : [];
  if (people.length > 20 || people.some((u) => !isId(u, "user"))) throw new InputError("Pick people from the team.", "team_map.people");
  const g = isObj(v && v.geocoding) ? v.geocoding : {};
  if (g.batch !== undefined && !["census", "off"].includes(g.batch)) throw new InputError("That isn't one of the choices.", "geocoding.batch");
  if (g.reverse !== undefined && !["nominatim", "off"].includes(g.reverse)) throw new InputError("That isn't one of the choices.", "geocoding.reverse");
  return {
    team_map: {
      enabled: tm.enabled === true,
      people: [...new Set(people)],
      every_s: intIn(tm.every_s, 60, 600, TEAM_DEFAULTS.every_s, "team_map.every_s"),
      retention_days: intIn(tm.retention_days, 1, 90, TEAM_DEFAULTS.retention_days, "team_map.retention_days"),
    },
    geocoding: { batch: g.batch === "off" ? "off" : "census", reverse: g.reverse === "off" ? "off" : "nominatim" },
  };
}

// Settings → Maps: how many properties still wait for a map point, and the geocoder's last word.
async function geocodeStatus() {
  const [rows, st, modes] = await Promise.all([listRel("geo-pending", "all", { limit: 500, newestFirst: false }), getRaw(STATE_KEY), geocodeModes()]);
  const s = st && st.data ? st.data : {};
  return { data: { waiting: rows.length, more: rows.length >= 500, modes, sources: mapSources(), today: s.day || null, sent_today: s.n || 0, last_batch: s.last_batch ?? null, last_matched: s.last_matched ?? null, backoff_until: s.fail_until || null } };
}
async function geocodeNow() {
  await kickWorker("bulk", "map.geocode");
  return { status: 202, data: { kicked: true } };
}

const R = (method, path, perm, subject, handler, extra = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...extra });

export default defineModule({
  name: "map",
  types: [pinType, territoryType],
  perms: [
    { key: "canvass:use", label: "Knock doors (the door-to-door map)", roles: { owner: true, admin: true, tech: false } },
    { key: "canvass:manage", label: "Draw territories and see everyone's pins", roles: { owner: true, admin: true, tech: false } },
    { key: "team_map:read", label: "See the team map (where people on the clock are)", roles: { owner: true, admin: true, tech: false } },
  ],
  settings: {
    // the live team map (who shares, how often, how long it's kept) and the geocoders
    map: { defaults: MAP_DEFAULTS, validate: validateMap, perm: "settings:owner" },
  },
  routes: [
    R("GET", "/map/knock", "canvass:use", "none", knockStart),
    R("GET", "/map/places", "canvass:use", "none", places),
    R("GET", "/map/pins", "canvass:use", "none", listPins),
    R("POST", "/map/pins", "canvass:use", "none", createPin, { replaySafe: true }),
    R("GET", "/map/pins/:id", "canvass:use", "required", getPin),
    R("PATCH", "/map/pins/:id", "canvass:use", "required", updatePin, { replaySafe: true }),
    R("DELETE", "/map/pins/:id", "canvass:use", "required", deletePin),
    R("POST", "/map/pins/:id/convert", "canvass:use", "required", convertPin),
    R("GET", "/map/reverse", "canvass:use", "none", reverse),
    R("GET", "/map/report", "canvass:use", "none", report),
    R("GET", "/map/territories", "canvass:use", "none", listTerritories),
    R("POST", "/map/territories", "canvass:manage", "none", createTerritory),
    R("GET", "/map/territories/:id", "canvass:use", "required", getTerritory),
    R("PATCH", "/map/territories/:id", "canvass:manage", "required", patchTerritory),
    R("DELETE", "/map/territories/:id", "canvass:manage", "required", deleteTerritory),
    R("GET", "/map/sharing", "time:own", "none", sharingRoute),
    R("POST", "/map/position", "time:own", "none", postPosition),
    R("GET", "/map/team", "team_map:read", "none", teamMap),
    R("POST", "/map/team/forget", "settings:owner", "none", forgetPositions),
    R("GET", "/map/geocode", "settings:owner", "none", geocodeStatus),
    R("POST", "/map/geocode", "settings:owner", "none", geocodeNow),
  ],
  sweeps: [
    { key: "map.geocode", label: "Map points from the Census geocoder", lane: "bulk", every: "pass", mutates: true, run: (ctx) => runCensusGeocode(ctx) },
    // privacy, so it runs while the CRM is paused too
    { key: "map.retention", label: "Delete old team-map positions", lane: "bulk", every: "daily", at_local: "03:20", mutates: true, maintenance: true, run: (ctx) => runRetention(ctx) },
  ],
  exportTypes: ["pin", "territory"],
});
