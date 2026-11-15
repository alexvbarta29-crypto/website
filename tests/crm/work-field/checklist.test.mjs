// The checklist as Rotor's crew works it (Nov 2026: the Technician Job
// Checklist): the template's item kinds (checkbox, pick one, number, photos
// with min and max, a group of checkboxes, notes; required or not; a tick
// that also texts On my way or starts the visit), the answers saved on the
// visit (online and replayed from a phone that had no signal), the
// required items gating Finish, the seeded list, and the phone's own rules
// (crm-app/modules/work/checklist-kit.js: done, x of N, complete in order).
// Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BYTES } from "../../helpers/crm-fixtures.mjs";
import { setup, customer, job, visit, clock, store, live, offline, post, patch, rec, OFF, TY, AUTOMATION } from "./fixtures.mjs";

const KIT = await import("../../../crm-app/modules/work/checklist-kit.js");
const jpeg = () => Buffer.from(BYTES.jpeg()).toString("base64");
const ITEMS = [
  { key: "omw", label: 'Send "On My Way" Text', required: true, kind: "check", hook: "on_my_way" },
  { key: "arrive", label: 'Arrive + Mark "Start Job"', required: true, kind: "check", hook: "start" },
  { key: "greet", label: "Client Greet", required: true, kind: "select", options: ["Greeted", "Nobody home"] },
  { key: "panes", label: "How many panes?", required: true, kind: "count", placeholder: "Enter Pane Count" },
  { key: "sides", label: "Pictures of all sides", required: true, kind: "photo", min: 2, max: 3 },
  { key: "pack", label: "Pack Up", required: true, kind: "multi", options: ["Pack up", "Walkaround"], min: 2 },
  { key: "notes", label: "Any Notes (Optional)", required: false, kind: "text", placeholder: "Enter detailed answer" },
];

test("schema: each kind keeps what it needs; bad shapes are refused with the field", () => {
  const ok = TY.validateChecklistTemplate({ key: "tech_list", name: "Tech list", items: ITEMS });
  assert.deepEqual(ok.items.map((i) => i.kind), ["check", "check", "select", "count", "photo", "multi", "text"]);
  assert.equal(ok.items[0].hook, "on_my_way");
  assert.deepEqual(ok.items[2].options, ["Greeted", "Nobody home"]);
  assert.deepEqual([ok.items[4].min, ok.items[4].max], [2, 3]);
  assert.equal(ok.items[5].min, 2);
  assert.equal(ok.items[3].placeholder, "Enter Pane Count");
  // defaults: a photo item needs one photo and takes up to ten; a group needs one tick
  const d = TY.validateChecklistTemplate({ key: "tech_list", name: "T", items: [{ key: "ph", label: "Photo", kind: "photo" }, { key: "gr", label: "G", kind: "multi", options: ["a", "b", "a"] }] });
  assert.deepEqual([d.items[0].min, d.items[0].max], [1, 10]);
  assert.deepEqual([d.items[1].options, d.items[1].min], [["a", "b"], 1], "choices once each");
  // a group's min never asks for more boxes than it has
  assert.equal(TY.validateChecklistTemplate({ key: "tech_list", name: "T", items: [{ key: "gr", label: "G", kind: "multi", options: ["a", "b"], min: 5 }] }).items[0].min, 2);
  const bad = (item, field) => assert.throws(() => TY.validateChecklistTemplate({ key: "tech_list", name: "T", items: [item] }), (e) => e.field && e.field.endsWith(field), field);
  bad({ key: "s0", label: "Pick", kind: "select" }, "options");
  bad({ key: "s1", label: "Pick", kind: "select", options: [] }, "options");
  bad({ key: "m1", label: "Group", kind: "multi", options: [""] }, "options");
  bad({ key: "p1", label: "Photos", kind: "photo", min: 4, max: 2 }, "max");
  bad({ key: "p2", label: "Photos", kind: "photo", max: 99 }, "max");
  bad({ key: "c1", label: "Tick", kind: "check", hook: "send_invoice" }, "hook");
  bad({ key: "k1", label: "Odd", kind: "wizard" }, "kind");
  bad({ key: "k2", label: "x".repeat(121), kind: "check" }, "label");
  // fields a kind doesn't use are dropped
  assert.deepEqual(TY.validateChecklistTemplate({ key: "tech_list", name: "T", items: [{ key: "c2", label: "Tick", kind: "check", options: ["x"], min: 3, placeholder: "p" }] }).items[0], { key: "c2", label: "Tick", required: false, kind: "check" });
  // a visit copies the shape, never an answer; a visit's own copy keeps its answers
  const copy = OFF.checklistCopy({ key: "tech_list", name: "Tech list", items: ok.items });
  assert.equal(copy.name, "Tech list");
  assert.deepEqual(copy.items[2].options, ["Greeted", "Nobody home"]);
  assert.equal(copy.items[0].hook, "on_my_way");
});

test("the seeded Technician Job Checklist: 15 items in Barta's order, 14 required, first in order for window and exterior jobs; seeded once", async () => {
  const { t, owner } = await setup();
  try {
    const c = OFF.TECH_CHECKLIST;
    assert.equal(c.items.length, 15);
    assert.equal(c.items.filter((i) => i.required).length, 14);
    assert.deepEqual(c.items.slice(0, 2).map((i) => i.hook), ["on_my_way", "start"]);
    assert.deepEqual([...new Set(c.items.map((i) => i.kind))].sort(), ["check", "count", "multi", "photo", "select", "text"]);
    TY.validateChecklistTemplate(c);
    for (const i of c.items) assert.doesNotMatch(i.label + (i.options || []).join(" "), /—/, "no em dashes");
    assert.deepEqual(await OFF.seedTechChecklist({ write: () => AUTOMATION }), { created: 1 });
    assert.deepEqual(await OFF.seedTechChecklist({ write: () => AUTOMATION }), { created: 0 }, "once");
    const cu = await customer(owner);
    const j = await job(owner, cu);
    const v = await visit(owner, j, { date: "2026-11-17", assignee_ids: [] });
    assert.equal(v.checklist.template_key, "technician_job");
    assert.equal(v.checklist.name, "Technician Job Checklist");
    assert.deepEqual(v.checklist.items.find((i) => i.key === "pack_up").options, ["Pack Up All Equipment", "Walkaround Property for Left Equipment"]);
    // the owner turns it off in Settings → Checklists: new visits get the old list again
    const ck = (await t.api("/checklists", { as: owner })).body.data.find((r) => r.k === "technician_job");
    const g = await t.api(`/checklists/${ck.id}`, { as: owner });
    const r = await t.api(`/checklists/${ck.id}`, { method: "PATCH", as: owner, ifMatch: g.headers.get("etag"), body: { active: false } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const v2 = await visit(owner, await job(owner, cu), { date: "2026-11-18", assignee_ids: [] });
    assert.equal(v2.checklist.template_key, "windows_exterior");
  } finally { t.done(); }
});

// A visit for the tech with ITEMS as its list (the template made through the API, as Settings does).
async function workday(t, owner, tech) {
  const r = await t.api("/checklists", { method: "POST", as: owner, body: { key: "kinds_list", name: "Kinds", service_types: ["Residential Window Cleaning"], job_kinds: [], items: ITEMS, order: 1, active: true } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = await customer(owner);
  const j = await job(owner, c);
  return visit(owner, j, { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
}
const item = (v, key) => v.checklist.items.find((i) => i.key === key);

test("answers by kind: a pick from its choices, a whole number, notes, a group done once enough are ticked; wrong answers refused", async () => {
  const { t, owner, tech } = await setup();
  try {
    const v = await workday(t, owner, tech);
    assert.equal(v.checklist.template_key, "kinds_list");
    const go = (body) => patch(t, tech, `/visits/${v.id}/checklist`, live(body));
    let r = await go({ key: "greet", done: true, value: "Somebody else" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.field, "value");
    r = await go({ key: "greet", done: true, value: "Greeted" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(item(r.body.data.visit, "greet").value, "Greeted");
    assert.equal(item(r.body.data.visit, "greet").done_at, clock.nowIso());
    assert.equal((await go({ key: "panes", done: true, value: 2.5 })).status, 400);
    r = await go({ key: "panes", done: true, value: 32 });
    assert.equal(item(r.body.data.visit, "panes").value, 32);
    // a group: one of two ticked is kept but not done; both is done; none clears it
    assert.equal((await go({ key: "pack", done: true, value: ["Pack up", "Nope"] })).status, 400);
    assert.equal((await go({ key: "pack", done: true, value: "Pack up" })).status, 400, "a group's answer is a list");
    r = await go({ key: "pack", done: true, value: ["Pack up"] });
    assert.deepEqual(item(r.body.data.visit, "pack").value, ["Pack up"]);
    assert.equal(item(r.body.data.visit, "pack").done_at, undefined, "one of two: not done");
    r = await go({ key: "pack", done: true, value: ["Walkaround", "Pack up"] });
    assert.deepEqual(item(r.body.data.visit, "pack").value, ["Pack up", "Walkaround"], "in the list's order");
    assert.ok(item(r.body.data.visit, "pack").done_at);
    r = await go({ key: "pack", done: false });
    assert.equal(item(r.body.data.visit, "pack").value, undefined);
    assert.equal(item(r.body.data.visit, "pack").done_at, undefined);
    assert.equal((await go({ key: "notes", done: true, value: "   " })).status, 400);
    r = await go({ key: "notes", done: true, value: "Synthetic: <b>hi</b>" });
    assert.equal(item(r.body.data.visit, "notes").value, "Synthetic: <b>hi</b>", "kept as typed; the screen escapes it");
    // a photo item can't be ticked by hand
    assert.equal((await go({ key: "sides", done: true })).status, 400);
    // the required ones gate Finish (the optional notes don't)
    r = await post(t, tech, `/visits/${v.id}/complete`, live());
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /Send "On My Way" Text, Arrive \+ Mark "Start Job", Pictures of all sides, Pack Up/);
    assert.doesNotMatch(r.body.error.message, /Any Notes/);
    // only the visit's people answer
    assert.equal((await patch(t, owner, `/visits/${v.id}/checklist`, live({ key: "greet", done: true, value: "Greeted" }))).status, 409, "the office isn't on it");
  } finally { t.done(); }
});

test("photos: an item is done at its fewest photos and takes no more than its most; the On my way and Start ticks come with the steps", async () => {
  const { t, owner, tech } = await setup();
  try {
    const v = await workday(t, owner, tech);
    const shot = () => post(t, tech, `/visits/${v.id}/photos`, live({ data: jpeg(), thumb: jpeg(), tag: "before", item: "sides" }));
    let r = await shot();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(item(r.body.data.visit, "sides").done_at, undefined, "one of two");
    r = await shot();
    assert.ok(item(r.body.data.visit, "sides").done_at, "two: done");
    r = await shot();
    assert.equal(r.status, 201);
    r = await shot();
    assert.equal(r.status, 400, "three at most");
    assert.equal(r.body.error.field, "item");
    const vv = await rec("visit", v.id);
    assert.equal(vv.photos.filter((p) => p.item === "sides").length, 3);
    // On my way ticks "Send On My Way Text"; Start ticks "Arrive + Mark Start Job"
    r = await post(t, tech, `/visits/${v.id}/on-my-way`, live({ eta_min: 15 }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.visit.status, "en_route");
    assert.ok(item(r.body.data.visit, "omw").done_at);
    assert.equal(item(r.body.data.visit, "omw").done_by, tech.id);
    assert.equal(item(r.body.data.visit, "arrive").done_at, undefined);
    r = await post(t, tech, `/visits/${v.id}/timer`, live({ action: "start" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(item(r.body.data.visit, "arrive").done_at);
    // the text stayed in the outbox (dry run)
    assert.ok(t.stores.data.keys("rec/outbox/").length >= 1);
  } finally { t.done(); }
});

test("offline: answers made with no signal replay in order, a group and a number included, and the phone's overlay matches", async () => {
  const { t, owner, tech } = await setup();
  try {
    const v = await workday(t, owner, tech);
    const at = clock.nowIso();
    const bodies = [{ key: "greet", done: true, value: "Nobody home" }, { key: "panes", done: true, value: 12 }, { key: "pack", done: true, value: ["Pack up"] }, { key: "pack", done: true, value: ["Pack up", "Walkaround"] }];
    for (const b of bodies) {
      const r = await patch(t, tech, `/visits/${v.id}/checklist`, offline(b, at));
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const got = await rec("visit", v.id);
    // the phone's overlay (tech-kit.js) laid over the server's first copy says the same
    const { overlayVisit } = await import("../../../crm-app/modules/work/tech-kit.js");
    const o = overlayVisit(v, bodies.map((b) => ({ path: `/visits/${v.id}/checklist`, body: { ...b, client_at: at } })), tech.id).visit;
    for (const k of ["greet", "panes", "pack"]) {
      assert.deepEqual(item(o, k).value, item(got, k).value, k);
      assert.equal(!!item(o, k).done_at, !!item(got, k).done_at, k);
    }
    assert.equal(KIT.progress(got.checklist.items).done, 3);
  } finally { t.done(); }
});

test("the phone's rules: done, x of N, the next item outlined and the ones after it waiting, hooks, answers, the editor", () => {
  const items = ITEMS.map((i) => ({ ...i }));
  let p = KIT.progress(items);
  assert.deepEqual(p, { total: 7, done: 0, left: 7, next: 0 });
  assert.equal(KIT.progressText(p), "Complete in order • 0 of 7 done");
  assert.equal(KIT.pillText(p), "7 left");
  assert.equal(KIT.locked(items, 0), false);
  assert.equal(KIT.locked(items, 1), true, "dimmed until reached");
  items[0] = KIT.applyAnswer(items[0], { done: true }, { at: "2026-11-17T15:00:00.000Z", by: "us_x" });
  assert.equal(KIT.locked(items, 1), false);
  assert.equal(KIT.progress(items).next, 1);
  // a group: partly ticked isn't done
  const g = KIT.applyAnswer(items[5], { done: true, value: ["Walkaround"] }, { at: "t" });
  assert.deepEqual([g.value, KIT.itemDone(g)], [["Walkaround"], false]);
  const g2 = KIT.applyAnswer(g, { done: true, value: ["Walkaround", "Pack up"] }, { at: "t2" });
  assert.deepEqual([g2.value, KIT.itemDone(g2)], [["Pack up", "Walkaround"], true]);
  assert.equal(KIT.itemDone(KIT.applyAnswer(g2, { done: false }, {})), false);
  // the optional item at the end never holds anything back
  const all = items.map((i) => (i.required ? { ...i, done_at: "t" } : i));
  p = KIT.progress(all);
  assert.deepEqual([p.done, p.left, p.next], [6, 1, -1]);
  assert.equal(KIT.locked(all, 6), false);
  assert.equal(KIT.pillText({ left: 0 }), "All done");
  // photos: done at min
  let v = { id: "vs_1", photos: [], checklist: { items: [{ ...ITEMS[4] }] } };
  v = KIT.photoAdded(v, "sides", { local: true, client_id: "a" }, { at: "t" });
  assert.equal(KIT.itemDone(v.checklist.items[0]), false);
  v = KIT.photoAdded(v, "sides", { local: true, client_id: "b" }, { at: "t" });
  assert.equal(KIT.itemDone(v.checklist.items[0]), true);
  assert.equal(KIT.itemPhotos(v, "sides").length, 2);
  // hooks only while the step is still ahead
  assert.equal(KIT.hookStep(ITEMS[0], "scheduled"), "omw");
  assert.equal(KIT.hookStep(ITEMS[0], "en_route"), null);
  assert.equal(KIT.hookStep(ITEMS[1], "en_route"), "start");
  assert.equal(KIT.hookStep(ITEMS[1], "in_progress"), null);
  assert.equal(KIT.hookStep(ITEMS[2], "scheduled"), null);
  // who answers: the visit's people while it's open
  assert.equal(KIT.canAnswer({ assignee_ids: ["us_t"], status: "in_progress" }, "us_t"), true);
  assert.equal(KIT.canAnswer({ assignee_ids: ["us_t"], status: "completed" }, "us_t"), false);
  assert.equal(KIT.canAnswer({ assignee_ids: ["us_t"], status: "scheduled" }, "us_o"), false);
  // the job's visit: under way, else the next booked, else the last
  assert.equal(KIT.currentVisit([{ id: "a", status: "completed" }, { id: "b", status: "scheduled" }, { id: "c", status: "en_route" }]).id, "c");
  assert.equal(KIT.currentVisit([{ id: "a", status: "completed" }, { id: "b", status: "scheduled" }]).id, "b");
  assert.equal(KIT.currentVisit([{ id: "a", status: "completed" }, { id: "x", status: "cancelled" }]).id, "a");
  assert.equal(KIT.currentVisit([]), null);
  // Settings → Checklists: the editor's fields
  assert.deepEqual(KIT.readItem({ key: "s", label: " Pick ", kind: "select", options: "A\n\nB\nA", required: true }), { key: "s", label: "Pick", kind: "select", required: true, options: ["A", "B"] });
  assert.match(KIT.readItem({ key: "s", label: "Pick", kind: "select", options: "" }).error, /choices/);
  assert.deepEqual(KIT.readItem({ key: "p", label: "Photos", kind: "photo", min: "2", max: "" }), { key: "p", label: "Photos", kind: "photo", required: false, min: 2, max: 10 });
  assert.match(KIT.readItem({ key: "p", label: "Photos", kind: "photo", min: "5", max: "2" }).error, /photos/);
  assert.deepEqual(KIT.readItem({ key: "m", label: "Group", kind: "multi", options: "a\nb", min: "9" }).min, 2);
  assert.equal(KIT.readItem({ key: "c", label: "Tick", kind: "check", hook: "start" }).hook, "start");
  assert.equal(KIT.readItem({ key: "c", label: "  " }), null, "a blank row is dropped");
});
