// The team phases (design §10.2 rows 1-3): the five Rotor members map to
// the CRM users Alex already made, by name; a user is created only for a
// member with no match (invited, no password); availability and pay rates
// fill only what is still empty; nothing an owner set is changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, importExport, store, generate, ids } from "./fixtures.mjs";

const U = await import("../../../netlify/lib/crm/modules/import/users.mjs");

function teamOnly(seed = 51) {
  const ex = generate({ scale: 0.02, seed });
  for (const k of Object.keys(ex)) if (!["members", "member_availability", "rate_settings"].includes(k)) ex[k] = [];
  return ex;
}
const user = async (id) => (await store.getRecord("user", id)).data;

test("matching is by name: full name first, then a first name only one user has; an owner's choice and an earlier mapping win", () => {
  const users = [
    { id: "us_00000000000000000001", name: "Avery Sample", first_name: "Avery", status: "active" },
    { id: "us_00000000000000000002", name: "Blake", first_name: "Blake", status: "active" },
    { id: "us_00000000000000000003", name: "Drew Example", first_name: "Drew", status: "active" },
    { id: "us_00000000000000000004", name: "Drew Other", first_name: "Drew", status: "active" },
    { id: "us_00000000000000000005", name: "Old Login", first_name: "Old", status: "disabled" },
  ];
  const m = (name) => U.normalizeMember({ user_id: "r-" + name.replace(/\W/g, ""), name });
  assert.deepEqual(U.matchMember(m("Avery Sample"), users), { id: "us_00000000000000000001", how: "name" });
  assert.deepEqual(U.matchMember(m("avery  SAMPLE"), users), { id: "us_00000000000000000001", how: "name" }, "case and spaces don't matter");
  assert.deepEqual(U.matchMember(m("Blake Sample"), users), { id: "us_00000000000000000002", how: "first_name" });
  assert.equal(U.matchMember(m("Drew Nobody"), users), null, "two users named Drew: no guess");
  assert.equal(U.matchMember(m("Old Login"), users), null, "a disabled login is not matched by name");
  assert.deepEqual(U.matchMember(m("Avery Sample"), users, { override: "us_00000000000000000003" }), { id: "us_00000000000000000003", how: "override" });
  const map = U.proposeMap([m("Avery Sample"), m("Avery Samples")], users);
  assert.equal(map[0].match.id, "us_00000000000000000001");
  assert.equal(map[1].match, null, "a user goes to one member only");
  assert.equal(U.ROLE_MAP.member, "tech");
  const r = U.normalizeRates({ hourly_rates: [{ user_id: "r1", category: "service", rate_cents_per_hour: 2000 }], commission_rates: [{ user_id: "r1", category: "technician", rate: 25 }] });
  assert.deepEqual(r.rates.map((x) => [x.kind, x.category, x.value]), [["hourly", "service", 2000], ["commission", "technician", 2500]], "percent → basis points");
});

test("all five Rotor members map to the users Alex made; nobody is created, roles and passwords untouched", async () => {
  const { t, owner, tech1 } = await setup();
  try {
    const ex = teamOnly();
    const r = await importExport(t, owner, ex);
    assert.equal(r.run.status, "done");
    const st = (await import("../../../netlify/lib/crm/modules/import/runner.mjs"));
    const state = await st.loadState(r.ir.id);
    assert.equal(Object.keys(state.users).length, 5);
    assert.equal(t.stores.data.keys("rec/user/").length, 5, "no user created");
    const me = await user(owner.id);
    assert.equal(me.role, "owner");
    assert.ok(me.password && me.password.hash, "the password is untouched");
    assert.equal(me.rotor.user_id, ex.members[0].user_id);
    assert.equal((await store.readPointer("rotor/user", ex.members[0].user_id)).id, owner.id);
    // availability filled (it was empty); a tech's pay rate filled (it was 0); is_technician is the owner's choice
    const tech = await user(tech1.id);
    assert.equal(tech.availability.length, 6);
    assert.equal(tech.pay.hourly_cents.service, 2000);
    assert.equal(me.pay.commission_pct.technician, 2500);
    // the owner changes a rate in the CRM: the next import leaves it alone
    await store.updateRecord("user", tech1.id, (u) => ({ ...u, pay: { ...u.pay, hourly_cents: { ...u.pay.hourly_cents, service: 2200 } } }), { by: owner.id, origin: "api", actor_kind: "user" });
    const again = await importExport(t, owner, ex);
    assert.equal(again.run.summary.conflicts_open, 0);
    assert.equal((await user(tech1.id)).pay.hourly_cents.service, 2200);
  } finally { t.done(); }
});

test("a member with no match becomes an invited user (no password) with Rotor's role; the owner's map wins over a name", async () => {
  const { t } = await setup({ withTeam: false });
  try {
    const owner = await t.user("owner", { name: "Avery Sample", login: "avery" });
    const other = await t.user("admin", { name: "Someone Else", login: "someone" });
    const ex = teamOnly(52);
    // Rotor's admin is really "Someone Else" in the CRM
    const { stageRun, runToEnd } = await import("./fixtures.mjs");
    const { ir } = await stageRun(t, owner, ex);
    const pre = (await t.api(`/import/runs/${ir.id}`, { as: owner })).body.data.team;
    assert.deepEqual(pre.members.map((m) => (m.match ? m.match.how : "new")), ["name", "new", "new", "new", "new"]);
    await t.api(`/import/runs/${ir.id}/user-map`, { method: "POST", as: owner, body: { map: { [ex.members[2].user_id]: other.id } } });
    const r = await runToEnd(t, owner, ir.id);
    assert.equal(r.run.status, "done");
    assert.equal((await store.readPointer("rotor/user", ex.members[2].user_id)).id, other.id);
    const made = await Promise.all([1, 3, 4].map((i) => user(ids.idForRotor("user", ex.members[i].user_id))));
    assert.deepEqual(made.map((u) => [u.status, u.role, u.password]), [["invited", "owner", null], ["invited", "tech", null], ["invited", "tech", null]]);
    assert.deepEqual(made.map((u) => u.login), ["blake", "drew", "emery"]);
    assert.ok(made.every((u) => u.created_by === "import"));
    assert.equal(made[1].is_technician, true, "a user the import made learns it goes out on visits");
    assert.equal((await user(other.id)).role, "admin", "a matched user's role is never changed");
    // a member created once is found again (no second user) on the next run
    const again = await (await import("./fixtures.mjs")).importExport(t, owner, ex);
    assert.equal(again.run.status, "done");
    assert.equal(t.stores.data.keys("rec/user/").length, 5);
  } finally { t.done(); }
});
