// The customer account's and the tracking page's data for the phone checks
// (tests/e2e/portal.spec.mjs): synthetic only (the shared seed's Harper
// Planfolk, 555 numbers, example.com emails, a made-up spot near Delano).
// Made in the same process as the e2e server, on top of the shared seed:
//
//   Harper's home on the map with counts for quoting; a visit today that
//   Theo is on the way to (the team map on, Theo clocked in, a trail from
//   his last stop), one next week and one next month; a finished visit last
//   month with a before and an after photo the tech marked for the customer
//   and an issue photo that stays with the office; an open invoice; hub
//   links (one per phone) and the tracking link.

const store = await import("../../netlify/lib/crm-store.mjs");
const clock = await import("../../netlify/lib/crm/core/clock.mjs");
const WORK = await import("../../netlify/lib/crm/modules/work/office.mjs");
const WT = await import("../../netlify/lib/crm/modules/work/timesheets.mjs");
const TEAM = await import("../../netlify/lib/crm/modules/map/team.mjs");
const INV = await import("../../netlify/lib/crm/modules/money/invoices.mjs");
const F = await import("../../netlify/lib/crm/core/files.mjs");
const PORTAL = await import("../../netlify/lib/crm/portal/core.mjs");
const TR = await import("../../netlify/lib/crm/portal/track.mjs");

export const HOME = [45.0419, -93.7891];
const LAST_STOP = [45.068, -93.716];

let made = null;
// photos: { before, after } JPEG bytes the spec made (a drawing of a window).
export function seedPortal(seeded, { photos }) {
  if (made) return made;
  made = store.withStoreScope({ requestId: "e2e-portal" }, async () => {
    const U = seeded.users;
    const O = { by: U.owner.id, origin: "api", actor_kind: "user", requestId: "e2e-portal" };
    const W = (uid) => ({ by: uid, origin: "api", actor_kind: "user", requestId: "e2e-portal" });
    const cid = seeded.contacts.plan;
    const c = (await store.getRecord("contact", cid)).data;
    const pid = c.primary_property_id;
    await store.updateRecord("property", pid, (p) => ({
      ...p, geo: { lat: HOME[0], lng: HOME[1], source: "manual", at: clock.nowIso() },
      assets: { windows: { standard: 22, slider: 6, sliding_door: 1, french: 5 }, panes_ext: 38, panes_int: 34, screens: 14, tracks: 8, stories: 2, gutter_ft: 160, ladder_ft: 28, notes: "Synthetic: 28 ft ladder on the back side, gate code at the side door.", services: ["windows_ext", "screens", "tracks_standard"], plan: "quarterly", from: { kind: "manual", at: clock.nowIso() } },
    }), O);
    const day = clock.localDate(clock.now());
    const job = async (title, n) => (await WORK.createJobs([{ contact_id: cid, property_id: pid, kind: "standard", lines: [{ title, unit_cents: 29500, service_type: "Residential Window Cleaning" }] }], `e2e-portal-${n}`, "manual", O))[0];
    const visit = async (jobId, date, start, who) => (await WORK.createVisit({ job_id: jobId, date, start, end: `${String(Number(start.slice(0, 2)) + 2).padStart(2, "0")}:00`, window: { type: "window", minutes: 120 }, assignee_ids: who }, O)).visit;
    const out = { contact: cid, property: pid };

    // today: Theo is on the way
    const t = clock.nowMs();
    const today = await visit(await job("Exterior window cleaning", 1), day, "10:00", [U.tech.id]);
    const omwAt = new Date(t - 7 * 60000).toISOString();
    await store.updateRecord("visit", today.id, (v) => ({ ...v, geo: HOME, status: "en_route", on_my_way: { at: omwAt, by: U.tech.id, eta_min: 20, geo: LAST_STOP, track: true } }), W(U.tech.id));
    out.track = `/p/track/${(await TR.createTrackLink({ visit: { ...today, contact_id: cid }, userId: U.tech.id, at: omwAt, tapKey: "e2e-portal-omw" })).code}`;
    await store.putSetting("map", { team_map: { enabled: true, people: [U.tech.id], every_s: 120, retention_days: 30 } }, { ...O, origin: "seed" });
    await store.putSetting("tracking", { enabled: true, show_vehicle: true, vehicles: { [U.tech.id]: "a white Ford Transit" } }, { ...O, origin: "seed" });
    await WT.clockIn({ id: U.tech.id }, { category: "service", time: { at: new Date(t - 3 * 3600000).toISOString(), trusted: true, source: "server" } }, W(U.tech.id));
    const pts = [];
    // earlier stops, then the last one, then on the road toward Harper's
    for (let i = 0; i < 6; i++) pts.push([45.1 - i * 0.004, -93.66 - i * 0.008, Math.floor((t - (90 - i * 10) * 60000) / 1000), 10, "i"]);
    pts.push([LAST_STOP[0], LAST_STOP[1], Math.floor((t - 9 * 60000) / 1000), 8, "f"]);
    for (let i = 1; i <= 4; i++) pts.push([Math.round((LAST_STOP[0] - i * 0.0042) * 1e5) / 1e5, Math.round((LAST_STOP[1] - i * 0.0095) * 1e5) / 1e5, Math.floor((t - (8 - i * 2) * 60000) / 1000), 10, "i"]);
    await store.settledWrite(TEAM.dayKey(day, U.tech.id), { uid: U.tech.id, day, pts }, { onlyIfNew: true });

    // next week and next month
    out.next = (await visit(await job("Exterior window cleaning", 2), clock.addLocalDays(day, 7), "08:00", [U.tech.id])).id;
    out.later = (await visit(await job("Interior window cleaning", 3), clock.addLocalDays(day, 35), "13:00", [U.tech2.id])).id;

    // last month, done, with the tech's photos
    const past = await visit(await job("Exterior window cleaning and screens", 4), clock.addLocalDays(day, -30), "09:00", [U.tech.id]);
    const file = async (bytes) => F.storeImportedFile({ bytes, owner: { type: "visit", id: past.id }, kind: "photo" }, W(U.tech.id));
    const before = await file(photos.before);
    const after = await file(photos.after);
    const issue = await file(photos.before);
    await store.updateRecord("visit", past.id, (v) => ({ ...v, status: "completed", completion: { at: new Date(t - 30 * 86400000).toISOString(), by: U.tech.id }, photos: [
      { file_id: before.id, tag: "before", customer_visible: true, at: new Date(t - 30 * 86400000).toISOString(), by: U.tech.id },
      { file_id: after.id, tag: "after", customer_visible: true, at: new Date(t - 30 * 86400000 + 3600000).toISOString(), by: U.tech.id },
      { file_id: issue.id, tag: "issue", customer_visible: false, at: new Date(t - 30 * 86400000 + 3700000).toISOString(), by: U.tech.id },
    ] }), W(U.tech.id));
    out.photos = { before: before.id, after: after.id, issue: issue.id };

    // an open invoice
    const inv = await INV.makeInvoice({ invoice: { id: INV.clientInvoiceId("00000000-0000-4000-8000-000000990001"), kind: "standard", contact_id: cid, job_ids: [], lines: [{ id: "p1", kind: "service", description: "Exterior window cleaning", qty_milli: 1000, unit_cents: 24310, total_cents: 24310 }], origin: "staff" }, issue: true, silent: true, credit: false, links: { job_ids: [] } }, O);
    out.invoice = inv.id;

    // a hub link for each phone (a link opens its cookie in that browser only)
    out.hub = {};
    for (const d of ["iphone13", "iphonese", "extra"]) out.hub[d] = `/p/${(await PORTAL.createPortalLink({ contact_id: cid, scope: { kind: "hub" }, created_by: U.owner.id })).code}`;
    return out;
  });
  return made;
}
