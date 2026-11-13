// The map module's data for the phone checks (tests/e2e/map.spec.mjs) and
// its screenshots: synthetic only (made-up names, 555 numbers, example.com
// emails, "Example" streets laid out on a made-up grid near Delano's
// center). Made in the same process as the e2e server, on top of the
// shared seed:
//
//   customers and open leads with a map point on the grid; door-to-door
//   pins by Olive, Ada and Theo over three days (a few to go back to
//   today); two areas (one Theo's); Theo allowed to knock doors; the team
//   map on for Theo, Tess and Olive, Theo and Tess clocked in with a trail
//   of positions (Theo's fresh, Tess's 14 minutes old).

const store = await import("../../netlify/lib/crm-store.mjs");
const clock = await import("../../netlify/lib/crm/core/clock.mjs");
const WT = await import("../../netlify/lib/crm/modules/work/timesheets.mjs");
const TEAM = await import("../../netlify/lib/crm/modules/map/team.mjs");

export const GRID = Object.freeze({ lat: 45.0419, lng: -93.7891, dLat: 0.0009, dLng: 0.0013 });
// house n on street s (0-based): a spot on the made-up grid
export const house = (s, n) => ({ lat: Math.round((GRID.lat + (s - 3) * GRID.dLat * 2 + 0.00028) * 1e6) / 1e6, lng: Math.round((GRID.lng + (n - 6) * GRID.dLng) * 1e6) / 1e6 });
const STREETS = ["Example Ave", "Sample St", "Placeholder Ln", "Demo Rd", "Tester Ct", "Madeup Way", "Notreal Dr"];
const TYPES = ["not_home", "not_home", "interested", "not_interested", "come_back", "booked", "not_home", "renter", "never_knock", "interested"];
const OUT = { not_home: "not_home", interested: "interested", not_interested: "not_interested", come_back: "talked", booked: "booked", renter: "talked", never_knock: "skip" };
const LABEL = { not_home: "Not home", interested: "Interested", not_interested: "Not interested", come_back: "Come back", booked: "Booked", renter: "Renter", never_knock: "Never knock" };
const COLOR = { not_home: "#808080", interested: "#d0b116", not_interested: "#e5484d", come_back: "#7c4dff", booked: "#03ad00", renter: "#2a78d6", never_knock: "#16161b" };

let made = null;
export function seedMap(seeded) {
  if (made) return made;
  made = store.withStoreScope({ requestId: "e2e-map" }, async () => {
    const U = seeded.users;
    const W = (by) => ({ by, origin: "api", actor_kind: "user", requestId: "e2e-map" });
    const O = W(U.owner.id);
    const today = clock.localDate(clock.now());
    const out = { places: [], pins: [], territories: [] };

    // customers and open leads on the grid
    for (let i = 0; i < 26; i++) {
      const s = i % 7;
      const n = (i * 5) % 13;
      const at = house(s, n);
      const lead = i % 4 === 3;
      const c = (await store.createRecord("contact", {
        first_name: ["Robin", "Jordan", "Casey", "Morgan", "Taylor", "Jamie", "Avery"][i % 7], last_name: "Mapfolk", phones: [{ e164: "+1763555" + String(2400 + i).padStart(4, "0"), sms: true }],
        emails: [{ address: `mapfolk${i}@example.com` }], lifecycle: lead ? "lead" : "customer", source: { source: lead ? "Door to Door" : "Referral" },
        consent: { sms_service: { state: "granted", source: "website_form" } }, billing_address: { street1: `${200 + n * 4} ${STREETS[s]}`, city: "Delano", state: "MN", zip: "55328" },
      }, O)).data;
      await store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: `${200 + n * 4} ${STREETS[s]}`, city: "Delano", state: "MN", zip: "55328", country: "US" }, access: {}, geo: { lat: at.lat, lng: at.lng, source: "manual", at: clock.nowIso() } }, O);
      out.places.push({ id: c.id, ...at, lead });
    }

    // pins: three days of knocking
    const who = [U.owner.id, U.tech.id, U.admin.id];
    let k = 0;
    for (let s = 0; s < 7; s++) {
      for (let n = 0; n < 13; n++) {
        if ((s * 13 + n) % 3 === 2) continue;
        k += 1;
        const type = TYPES[k % TYPES.length];
        const by = who[k % 3];
        const daysAgo = k % 4 === 0 ? 2 : k % 3 === 0 ? 1 : 0;
        const at = new Date(clock.nowMs() - daysAgo * 86400000 - (k % 50) * 60000).toISOString();
        const spot = house(s, n);
        const rec = {
          lat: spot.lat + 0.00012, lng: spot.lng, type_key: type, type_label: LABEL[type], type_color: COLOR[type], outcome: OUT[type],
          knocks: [{ at, by, type_key: type, outcome: OUT[type] }], canvasser_id: by,
          address: { street1: `${201 + n * 4} ${STREETS[s]}`, city: "Delano", state: "MN", zip: "55328" }, address_source: "reverse",
          ...(type === "come_back" || (type === "interested" && k % 2) ? { follow_up_on: k % 2 ? today : clock.addLocalDays(today, 2), note: "Synthetic: talked to the owner, wants gutters too." } : {}),
        };
        const r = await store.createRecord("pin", rec, W(by));
        out.pins.push(r.data.id);
      }
    }

    // two areas: the west blocks (Theo's), the east blocks (Olive's)
    const west = [[GRID.lng - 7.5 * GRID.dLng, GRID.lat - 7 * GRID.dLat], [GRID.lng - 0.5 * GRID.dLng, GRID.lat - 7 * GRID.dLat], [GRID.lng - 0.5 * GRID.dLng, GRID.lat + 7 * GRID.dLat], [GRID.lng - 7.5 * GRID.dLng, GRID.lat + 7 * GRID.dLat]];
    const east = [[GRID.lng + 0.5 * GRID.dLng, GRID.lat - 7 * GRID.dLat], [GRID.lng + 7.5 * GRID.dLng, GRID.lat - 7 * GRID.dLat], [GRID.lng + 7.5 * GRID.dLng, GRID.lat + 7 * GRID.dLat], [GRID.lng + 0.5 * GRID.dLng, GRID.lat + 7 * GRID.dLat]];
    out.territories.push((await store.createRecord("territory", { name: "West blocks", color: "#2563eb", polygon: west, assignee_ids: [U.tech.id], active: true }, O)).data.id);
    out.territories.push((await store.createRecord("territory", { name: "East blocks", color: "#db3a29", polygon: east, assignee_ids: [U.owner.id], active: true }, O)).data.id);

    // Theo may knock doors (an owner's per-person switch)
    await store.updateRecord("user", U.tech.id, (u) => ({ ...u, grants: [...new Set([...(u.grants || []), "canvass:use"])] }), O);

    // the team map: on for Theo, Tess and Olive; Theo and Tess on the clock, with a trail
    await store.putSetting("map", { team_map: { enabled: true, people: [U.tech.id, U.tech2.id, U.owner.id], every_s: 120, retention_days: 30 }, geocoding: { batch: "census", reverse: "nominatim" } }, { ...O, origin: "seed" });
    const t = clock.nowMs();
    for (const [uid, base, lateMin] of [[U.tech.id, [45.0419, -93.7886], 2], [U.tech2.id, [44.9897, -93.7258], 14]]) {
      await WT.clockIn({ id: uid }, { category: "service", time: { at: new Date(t - 90 * 60000).toISOString(), trusted: true, source: "server" } }, W(uid));
      const pts = [];
      for (let i = 0; i < 24; i++) {
        const ts = Math.floor((t - lateMin * 60000 - (23 - i) * 120000) / 1000);
        pts.push([Math.round((base[0] - 0.02 + i * 0.0009) * 1e5) / 1e5, Math.round((base[1] - 0.03 + i * 0.0013 + (i % 3) * 0.0004) * 1e5) / 1e5, ts, 12, i === 23 ? "s" : "i"]);
      }
      await store.settledWrite(TEAM.dayKey(today, uid), { uid, day: today, pts }, { onlyIfNew: true });
    }
    return out;
  });
  return made;
}
