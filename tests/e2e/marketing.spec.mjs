// Track 1 of the Rotor guide (scratchpad simplify/guide-gaps.md §2.3,
// §2.14, §2.15, §7): every changed screen at iPhone 13 and iPhone SE, in
// light and dark, passes the phone checks (no cut-off text, 44 px targets,
// no sideways scroll, no console or CSP errors): the Inbox with its folder
// tiles, a person's thread with the composer's Text | Email | Note and the
// person's panel, Marketing's four tabs (Workflows in folders, Campaigns'
// tiles, Reviews with star ratings, Templates' tiles) and the new Settings
// rows (Business numbers, Muted contacts, Reviews, Client portal, Team
// inboxes); the Leads section's QR codes tab; and a desk still works.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, screenProblems, shot, noInstallCard } from "./kit.mjs";

let srv, browser, seeded;
before(async () => { srv = await start(); seeded = await srv.seed(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(login, device, theme = "dark") {
  const p = await phone(browser, srv, { device, office: device === "desk1440" });
  await signIn(p, login);
  await p.page.goto("/office");
  let f = await crmFrame(p.page);
  await settled(f);
  if (theme !== "dark") {
    await f.evaluate((t) => localStorage.setItem("crm-theme", t), theme);
    await p.page.reload();
    f = await crmFrame(p.page);
    await settled(f);
  }
  await noInstallCard(p.page);
  return { p, page: p.page, f };
}
const sheetGone = (f) => f.waitForFunction(() => !document.querySelector(".sheet"), null, { timeout: 5000 });

for (const device of ["iphone13", "iphonese"]) {
  for (const theme of ["light", "dark"]) {
    test(`Track 1 screens (${device}, ${theme}): Inbox, a thread and its panel, Marketing's tabs, the new Settings rows`, async () => {
      const { p, page, f } = await open("olive", device, theme);
      const c = seeded.comms;
      const check = async (path, re, name) => {
        await goTo(f, path);
        if (re) await f.waitForFunction((src) => new RegExp(src).test(document.getElementById("view").textContent), re.source, { timeout: 8000 });
        assert.deepEqual(await screenProblems(f), [], `${name} passes the phone checks`);
        await shot(page, `t1-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${device}-${theme}`);
      };
      try {
        assert.equal(await f.evaluate(() => document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")), theme);
        await check("/inbox", /Needs reply/, "Inbox");
        assert.ok(await f.$('#view [data-tile=inbox][data-key="sales"]'), "the team inbox tile");
        await check(`/inbox/${c.conversation}`, /gate code/, "Thread");
        await f.click('[data-seg=ch][data-key="note"]');
        assert.deepEqual(await screenProblems(f), [], "the note composer");
        await f.click('[data-seg=ch][data-key="sms"]');
        await f.click("#top-act [data-panel]");
        await f.waitForSelector(".sheet.on [data-mute]", { timeout: 8000 });
        assert.deepEqual(await screenProblems(f), [], "the person's panel");
        await shot(page, `t1-panel-${device}-${theme}`);
        await f.click(".sheet.on [data-sheet-x]");
        await sheetGone(f);
        await check("/automations", /All folders/, "Workflows");
        assert.ok((await f.$$("#view [data-toggle]")).length > 3, "every built-in message is a row with its switch");
        await check("/campaigns", /Attributed ARR/, "Campaigns");
        await check("/reviews", /Needs follow-up/, "Reviews");
        await check("/templates", /Texts/, "Templates");
        assert.ok(await f.$("#view [data-tile=tpl]"), "the Templates tiles");
        // Marketing's four tabs under the title
        assert.deepEqual(await f.$$eval("#subnav .rs-seg-t", (els) => els.map((e) => e.textContent)), ["Workflows", "Campaigns", "Reviews", "Templates"]);
        await check("/settings/numbers", /Rotor still has the business number/, "Business numbers");
        await check("/settings/muted", /Muted|No list yet|Nobody/, "Muted contacts");
        await check("/settings/reviews", /Every rating/, "Review settings");
        await check("/settings/portal", /How long links stay open/, "Client portal");
        await check("/settings/inboxes", /Sales/, "Team inboxes");
        await f.click("#view [data-ib-open]");
        await f.waitForSelector(".sheet.on [data-ib-f]");
        assert.deepEqual(await screenProblems(f), [], "a team inbox's page");
        await f.click(".sheet.on [data-sheet-x]");
        await sheetGone(f);
        // Leads: its list and the QR codes tab (Forms and Referrals wait for their screens)
        await goTo(f, "/signs");
        assert.deepEqual(await f.$$eval("#subnav .rs-seg-t", (els) => els.map((e) => e.textContent)), ["Leads", "QR codes"]);
        await p.clean();
      } finally { await p.close(); }
    });
  }
}

test("Track 1 on a desk: the Inbox's tiles beside a thread, Workflows, Reviews and Campaigns", async () => {
  const { p, page, f } = await open("olive", "desk1440");
  const c = seeded.comms;
  try {
    await goTo(f, "/inbox");
    await f.click(`#view a[href="#/inbox/${c.conversation}"]`);
    await settled(f, { hash: `#/inbox/${c.conversation}` });
    assert.equal(await f.isVisible("#pane"), true);
    assert.ok(await f.$("#view [data-tile=inbox]"), "the tiles stay beside the thread");
    assert.ok(await f.$('#pane [data-seg=ch][data-key="note"]'));
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "t1-inbox-desk");
    for (const path of ["/automations", "/reviews", "/campaigns"]) {
      await goTo(f, path);
      assert.deepEqual(await screenProblems(f), [], `${path} on a desk`);
    }
    await p.clean();
  } finally { await p.close(); }
});
