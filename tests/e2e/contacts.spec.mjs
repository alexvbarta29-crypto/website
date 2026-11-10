// Phone checks of the contacts screens (M2a; design §12.4, §9.2): the
// Contacts list with its search, one contact and its tabs (the Sales tab),
// a tech's quick lead, at iPhone 13 and iPhone SE sizes. `npm run e2e`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, badLinks, screenProblems, shot, tap, noInstallCard } from "./kit.mjs";

let srv, browser, seeded;
before(async () => { srv = await start(); seeded = await srv.seed(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(login, device) {
  const p = await phone(browser, srv, { device });
  await signIn(p, login);
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  return { p, page: p.page, f };
}

for (const device of ["iphone13", "iphonese"]) {
  test(`contacts (${device}): open the list, search, open a contact and its Sales tab`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      await f.click('#tabs [data-tab="contacts"]');
      await settled(f, { hash: "#/contacts" });
      assert.equal(await title(f), "Contacts");
      assert.match(await f.textContent("#ct-count"), /^2\d\d contacts/, "the 200 seeded people and the leads");
      assert.deepEqual(await screenProblems(f), [], "the list passes the phone checks");
      await shot(page, `contacts-list-${device}`);
      // search: by phone digits, then by name (one row each)
      const search = async (q, name) => {
        await f.fill("#ct-q", q);
        await f.waitForFunction((n) => document.querySelectorAll("#ct-list a.row").length === 1 && document.getElementById("ct-list").textContent.includes(n), name, { timeout: 5000 });
      };
      await search("555-1902", "Blair Calledonce");
      await search("Newlead", "Avery Newlead");
      await tap(page, f, "#ct-list a.row");
      await settled(f, { hash: `#/contacts/${seeded.contacts.lead}` });
      assert.match(await f.textContent("#view"), /Avery Newlead/);
      assert.deepEqual(await screenProblems(f), [], "the contact passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `contacts-contact-${device}`);
      // its tabs: Activity, Properties, then the Sales tab (M2b)
      for (const tab of ["activity", "properties", "sales"]) {
        await f.click(`#view [data-tab="${tab}"]`);
        await f.waitForFunction((t) => document.querySelector(`#view [data-tab="${t}"]`).getAttribute("aria-pressed") === "true", tab);
        await f.waitForFunction(() => !document.querySelector("#view .sk"), null, { timeout: 10000 });
      }
      assert.match(await f.textContent("#view"), /New lead/i, "the Sales tab shows the follow-up");
      assert.deepEqual(await screenProblems(f), [], "the Sales tab passes the phone checks");
      await shot(page, `contacts-sales-tab-${device}`);
      // back keeps the search
      await f.click("#top-back");
      await settled(f, { hash: "#/contacts" });
      assert.equal(await f.inputValue("#ct-q"), "Newlead");
      await p.clean();
    } finally { await p.close(); }
  });
}

test("contacts: a tech's quick lead, and no contact list for a tech", async () => {
  const { p, page, f } = await open("theo", "iphonese");
  try {
    await goTo(f, "/contacts");
    assert.match(await f.textContent("#view"), /Not for this login/);
    await goTo(f, "/leads/new");
    assert.equal(await title(f), "Quick lead");
    assert.deepEqual(await screenProblems(f), [], "the quick lead form passes the phone checks");
    await shot(page, "contacts-quick-lead");
    const fields = await f.$$eval("#view input, #view textarea", (els) => els.map((e) => e.name).filter(Boolean));
    assert.ok(fields.includes("name") && fields.includes("phone"), `the form asks for a name and a phone (${fields.join(", ")})`);
    await f.fill('#view [name="name"]', "Jordan Quickpick");
    await f.fill('#view [name="phone"]', "763-555-1990");
    await f.click('#view button[type="submit"]');
    await settled(f, { hash: "#/today" });
    assert.match(await f.textContent(".toasts"), /Sent to the office/);
    // the office sees the lead (the tech was told only its id)
    const o = await phone(browser, srv);
    try {
      await signIn(o, "olive");
      const list = await o.ctx.request.get("/api/crm/contacts?q=Quickpick", { headers: { "x-crm": "1" } });
      assert.equal(list.status(), 200);
      assert.equal((await list.json()).data.length, 1, "the office has the quick lead");
    } finally { await o.close(); }
    await p.clean();
  } finally { await p.close(); }
});

test("contacts: the first slice's customer list for the office, not for a tech", async () => {
  const { p, f } = await open("olive", "iphone13");
  try {
    await goTo(f, "/legacy/customers");
    assert.equal(await title(f), "Customers");
    assert.deepEqual(await badLinks(f), []);
    await p.clean();
  } finally { await p.close(); }
  const t = await phone(browser, srv);
  try {
    await signIn(t, "theo");
    const res = await t.page.goto("/crm/legacy");
    assert.equal(res.status(), 403, "/crm/legacy for a tech");
    await t.clean({ allow: [/403/] });
  } finally { await t.close(); }
});
