// The address hold (core/ui.js; the owner, Nov 2026: "make addresses
// copyable whenever you hold down on them"): a long press (a finger on a
// phone, the mouse held or a right click on a desk) on an address copies
// it, says "Address copied" and leaves the screen where it was; a tap still
// opens the property. A lead's page, a customer's, a job's, the Customers
// list on a desk and a tech's visit, at iPhone 13 and a 1440 desk. The
// house picture stays away here (Google Maps isn't live on this server):
// the pages look as they did. Synthetic data only.
// `node --test tests/e2e/address.spec.mjs` (E2E_SHOTS=dir).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, screenProblems, shot, noInstallCard, frameOffset, DEVICES } from "./kit.mjs";

let srv, browser, seeded;
before(async () => { srv = await start(); seeded = await srv.seed(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(login, device) {
  const p = await phone(browser, srv, { device, office: true });
  await p.ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: srv.url });
  await signIn(p, login);
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  return { p, page: p.page, f };
}

// A long press where the element is: a finger on a phone (touch events), the mouse held (or a right click) on a desk.
async function hold(p, f, selector, { device, right = false, ms = 700 } = {}) {
  await f.$eval(selector, (el) => el.scrollIntoView({ block: "center" }));
  await f.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  const o = await frameOffset(p.page, f);
  const r = await f.$eval(selector, (el) => { const b = el.getBoundingClientRect(); return { x: b.left + Math.min(b.width / 2, 60), y: b.top + b.height / 2 }; });
  const x = o.x + r.x, y = o.y + r.y;
  if (DEVICES[device].desktop) {
    if (right) { await p.page.mouse.click(x, y, { button: "right" }); return; }
    await p.page.mouse.move(x, y);
    await p.page.mouse.down();
    await p.page.waitForTimeout(ms);
    await p.page.mouse.up();
    return;
  }
  const cdp = await p.ctx.newCDPSession(p.page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await p.page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}
const clip = (f) => f.evaluate(() => navigator.clipboard.readText());
const clear = (f) => f.evaluate(() => navigator.clipboard.writeText("-"));
// (a desk opens a contact beside the list: #pane)
const IN = ":is(#view, #pane)";
const toastSays = (f, text) => f.waitForFunction((t) => [...document.querySelectorAll("#toasts .toast")].some((x) => x.textContent === t), text, { timeout: 4000 });

for (const device of ["iphone13", "desk1440"]) {
  test(`address hold (${device}): a lead, a customer, a job, the list: hold copies, a tap still opens`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      // a lead: the CONTACT card's address row
      await goTo(f, `/contacts/${seeded.contacts.lead}`);
      const leadSel = `${IN} #ct-reach [data-address="301 Example Ave, Delano, MN 55328"]`;
      await f.waitForSelector(leadSel);
      await clear(f);
      await hold(p, f, leadSel, { device });
      await toastSays(f, "Address copied");
      assert.equal(await clip(f), "301 Example Ave, Delano, MN 55328");
      assert.equal(await f.evaluate(() => location.hash), `#/contacts/${seeded.contacts.lead}`, "the hold opened nothing");
      assert.deepEqual(await screenProblems(f), [], "the lead page passes the phone checks");
      await shot(page, `address-lead-${device}`);

      // a customer (their main property): hold copies the street address (never the gate code); a tap opens the property
      const c = await (await p.ctx.request.get(`/api/crm/jobs/${seeded.jobs[0]}`, { headers: { "x-crm": "1" } })).json();
      const cid = c.data.contact.id;
      await goTo(f, `/contacts/${cid}`);
      // (a phone: the CONTACT card's Primary property row; a desk: the PRIMARY PROPERTY card)
      const propSel = `${IN} a[data-address="700 Example Ave, Delano, MN 55328"]`;
      await f.waitForSelector(propSel);
      await clear(f);
      await hold(p, f, propSel, { device, right: device === "desk1440" });
      await toastSays(f, "Address copied");
      assert.equal(await clip(f), "700 Example Ave, Delano, MN 55328");
      assert.equal(await f.evaluate(() => location.hash), `#/contacts/${cid}`);
      await page.waitForTimeout(800);
      await f.click(propSel);
      await settled(f, { hash: `#/properties/${c.data.property.id}` });
      // the property page's address too
      await clear(f);
      await hold(p, f, `${IN} h2[data-address="700 Example Ave, Delano, MN 55328"]`, { device });
      await toastSays(f, "Address copied");
      assert.equal(await clip(f), "700 Example Ave, Delano, MN 55328");

      // a job: the address card (a phone) or the customer card's address (a desk)
      await goTo(f, `/jobs/${seeded.jobs[0]}`);
      const jobSel = `${IN} [data-address="700 Example Ave, Delano, MN 55328"]`;
      await f.waitForSelector(jobSel);
      await clear(f);
      await hold(p, f, jobSel, { device });
      await toastSays(f, "Address copied");
      assert.equal(await clip(f), "700 Example Ave, Delano, MN 55328");
      assert.equal(await f.evaluate(() => location.hash), `#/jobs/${seeded.jobs[0]}`);
      assert.deepEqual(await screenProblems(f), [], "the job page passes the phone checks");
      await shot(page, `address-job-${device}`);

      // the Customers list: a row's second line (a phone; a hold elsewhere still opens the row's "...") or the City cell (a desk)
      await goTo(f, "/contacts");
      const rowSel = device === "desk1440" ? "#view .rs-trow [data-address]" : "#view .rs-lrow [data-address]";
      await f.waitForSelector(rowSel);
      const want = await f.getAttribute(rowSel, "data-address");
      assert.match(want, /^\d+ Example Ave, [A-Za-z ]+ 55328$/);
      await clear(f);
      await hold(p, f, rowSel, { device });
      await toastSays(f, "Address copied");
      assert.equal(await clip(f), want);
      assert.equal(await f.evaluate(() => location.hash), "#/contacts", "the row didn't open");
      assert.equal(await f.$(".sheet.on"), null, "and its \"...\" didn't either");
      await p.clean();
    } finally { await p.close(); }
  });
}

test("address hold (iphone13): a tech's visit and Today", async () => {
  const { p, f } = await open("theo", "iphone13");
  try {
    await goTo(f, `/visits/${seeded.visits.tech}`);
    const sel = '#view [data-address="700 Example Ave, Delano, MN 55328"]';
    await f.waitForSelector(sel);
    await clear(f);
    await hold(p, f, sel, { device: "iphone13" });
    await toastSays(f, "Address copied");
    assert.equal(await clip(f), "700 Example Ave, Delano, MN 55328");
    assert.equal(await f.evaluate(() => location.hash), `#/visits/${seeded.visits.tech}`);
    await p.clean();
  } finally { await p.close(); }
});
