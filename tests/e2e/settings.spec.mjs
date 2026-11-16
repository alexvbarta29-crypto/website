// The Settings hub as groups (Nov 2026, the owner: "there is still way too
// much stuff, just make it more organized"; "the settings has a ton of
// things"): eight group rows (a coloured tile, the name, a grey line of
// what is inside, a chevron), a group's own page (#/settings/g/:key, its
// rows in one card, the round back to Settings), a group with one row going
// straight to it, the search listing every row flat with its group's name,
// at iPhone 13 and SE in both themes; an admin without the owners' groups;
// a tech without Settings. `node --test tests/e2e/settings.spec.mjs`;
// E2E_SHOTS=<dir> saves screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, hashOf, backShown, screenProblems, shot, noInstallCard, openDrawer } from "./kit.mjs";

let srv, browser;
before(async () => { srv = await start(); await srv.seed(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(login, device, theme = "light") {
  const p = await phone(browser, srv, { device, office: true });
  await signIn(p, login);
  await p.page.goto("/office");
  let f = await crmFrame(p.page);
  await settled(f);
  if (theme !== "light") {   // (light is the default: the owner, Nov 2026)
    await f.evaluate((t) => localStorage.setItem("crm-theme", t), theme);
    await p.page.reload();
    f = await crmFrame(p.page);
    await settled(f);
  }
  await noInstallCard(p.page);
  return { p, page: p.page, f };
}
// a still picture: the Menu gone, no passing hint over the rows
async function still(f) {
  await f.waitForFunction(() => !document.querySelector(".fm-sheet"), null, { timeout: 5000 });
  await f.evaluate(() => { for (const t of document.querySelectorAll(".toast")) t.remove(); });
}
const GROUPS = ["Business", "Team", "Services & pricing", "Messages", "Payments", "Connections", "Rotor & data", "This phone"];
const groupRows = (f) => f.$$eval("#view .set-groups [data-group]", (els) => els.map((e) => {
  const sub = e.querySelector(".sub");
  return { key: e.dataset.group, name: e.querySelector(".nm").textContent, sub: sub.textContent, cut: sub.scrollWidth > sub.clientWidth + 1, href: e.getAttribute("href"), h: e.getBoundingClientRect().height, tile: !!e.querySelector(".set-ic svg") };
}));

for (const device of ["iphone13", "iphonese"]) {
  for (const theme of ["light", "dark"]) {
    test(`Settings (${device}, ${theme}): eight groups with what is inside, a group's page and back, the search finds Discounts`, async () => {
      const { p, page, f } = await open("olive", device, theme);
      try {
        // the Menu's last row opens Settings
        await openDrawer(f);
        await f.click('.fm-sheet a[href="#/settings"]');
        await settled(f, { hash: "#/settings" });
        assert.equal(await title(f), "Settings");
        const rows = await groupRows(f);
        assert.deepEqual(rows.map((r) => r.name), GROUPS, "the eight groups, in order");
        for (const r of rows) {
          assert.ok(r.sub.length > 3 && !r.cut, `${r.name}: a whole grey line (${r.sub})`);
          assert.ok(r.h >= 44 && r.tile, `${r.name}: a 44 px row with its tile`);
        }
        assert.equal(rows.find((r) => r.key === "team").sub, "Team, permissions, payroll");
        assert.equal(rows.find((r) => r.key === "payments").href, "#/settings/g/payments", "Payments and Client portal: its page");
        assert.equal(rows.find((r) => r.key === "business").href, "#/settings/g/business");
        assert.equal(await f.isVisible("#view .set-res"), false, "no flat list until something is typed");
        assert.match(await f.textContent("#view .set-hub"), /App version/, "About at the bottom");
        assert.deepEqual(await screenProblems(f), [], "the hub passes the phone checks");
        await still(f);
        await shot(page, `settings-hub-${device}-${theme}`);

        // a group: its page, its rows in one card, the round back
        await f.click('#view [data-group="services"]');
        await settled(f, { hash: "#/settings/g/services" });
        assert.equal(await title(f), "Services & pricing");
        assert.ok(await backShown(f), "the round back");
        assert.equal(await f.$$eval("#view .set-grp ul.list", (els) => els.length), 1, "one inset card");
        assert.deepEqual(await f.$$eval("#view .set-grp .set-row .nm", (els) => els.map((e) => e.textContent)), ["Prices & price book", "Discounts", "Plans & perks", "Agreements", "Checklists", "Crew & forecast"]);
        assert.deepEqual(await screenProblems(f), [], "the group page passes the phone checks");
        await still(f);
        await shot(page, `settings-group-${device}-${theme}`);
        // a row opens its screen; back comes to the group, then to Settings
        await f.click('#view a[href="#/settings/checklists"]');
        await settled(f, { hash: "#/settings/checklists" });
        await f.click("#top-back");
        await settled(f, { hash: "#/settings/g/services" });
        await f.click("#top-back");
        await settled(f, { hash: "#/settings" });
        assert.equal(await f.isVisible("#top-back"), false, "Settings is top-level");

        // This phone: Light or dark opens the picker from the group's page
        await f.click('#view [data-group="phone"]');
        await settled(f, { hash: "#/settings/g/phone" });
        assert.deepEqual(await f.$$eval("#view .set-grp .set-row .nm", (els) => els.map((e) => e.textContent)), ["Light or dark", "Tab bar", "Calendar feed"]);
        await f.click("#view [data-theme-row]");
        await f.waitForSelector(".sheet.on");
        await page.keyboard.press("Escape");
        await f.waitForFunction(() => !document.querySelector(".sheet.on"));
        await f.click("#top-back");
        await settled(f, { hash: "#/settings" });

        // the search: every row of every group, flat, with its group's name
        await f.fill("#view [data-set-q]", "Discounts");
        assert.equal(await f.isVisible("#view .set-groups"), false, "the groups step aside");
        const hits = await f.$$eval("#view .set-res li:not([hidden])", (els) => els.map((e) => [e.querySelector(".nm").textContent, e.querySelector(".sub").textContent]));
        assert.deepEqual(hits, [["Discounts", "Services & pricing"]]);
        assert.deepEqual(await screenProblems(f), []);
        await shot(page, `settings-search-${device}-${theme}`);
        await f.fill("#view [data-set-q]", "rotor");
        const rotor = await f.$$eval("#view .set-res li:not([hidden]) .nm", (els) => els.map((e) => e.textContent));
        assert.ok(rotor.includes("Import from Rotor") && rotor.includes("Switch from Rotor"), rotor.join());
        await f.fill("#view [data-set-q]", "zzz nothing");
        assert.ok(await f.isVisible("#view .set-none"), "No setting by that name");
        await f.fill("#view [data-set-q]", "disc");
        await f.click('#view .set-res a[href="#/settings/discounts"]');
        await settled(f, { hash: "#/settings/discounts" });
        await f.click("#top-back");
        await settled(f, { hash: "#/settings" });
        // clearing the field brings the groups back
        await f.fill("#view [data-set-q]", "");
        assert.ok(await f.isVisible("#view .set-groups"));
        assert.equal(await f.isVisible("#view .set-res"), false);
        assert.equal((await groupRows(f)).length, 8);
        await p.clean();
      } finally { await p.close(); }
    });
  }
}

test("Settings for an admin: only the groups with something they may open; a deep link to a group", async () => {
  const { p, page, f } = await open("ada", "iphonese");
  try {
    await goTo(f, "/settings/g/team");
    assert.match(await f.textContent("#view"), /Nothing in this group for your login/);
    await goTo(f, "/settings");
    const rows = await groupRows(f);
    assert.deepEqual(rows.map((r) => r.name), ["Business", "Services & pricing", "Messages", "Connections", "Rotor & data", "This phone"], "no Team, no Payments");
    assert.equal(await f.$('#view a[href="#/settings/permissions"], #view a[href="#/settings/pricing"], #view a[href="#/import"]'), null, "no owners' rows, even in the search list");
    await goTo(f, "/settings/g/connections");
    assert.deepEqual(await f.$$eval("#view .set-grp .set-row .nm", (els) => els.map((e) => e.textContent)), ["Claude connector", "Door to door"]);
    assert.ok(await backShown(f), "the round back to Settings");
    await f.click("#top-back");
    await settled(f, { hash: "#/settings" });
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "settings-admin-iphonese");
    await p.clean();
  } finally { await p.close(); }
});

test("Settings for a tech: not theirs (the hub and every group)", async () => {
  const { p, f } = await open("theo", "iphone13");
  try {
    for (const path of ["/settings", "/settings/g/phone", "/settings/g/business"]) {
      await goTo(f, path);
      assert.match(await f.textContent("#view"), /Not for this login/, path);
      assert.equal(await f.$("#view [data-group], #view .set-row"), null, `${path}: no rows`);
    }
    assert.equal(await hashOf(f), "#/settings/g/business");
    await p.clean();
  } finally { await p.close(); }
});
