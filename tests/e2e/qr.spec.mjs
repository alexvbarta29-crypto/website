// Phone checks of the two QR screens (docs/CRM-MONEY.md "Scan to pay",
// docs/CRM-SALES.md "Signs & flyers"), at iPhone 13, iPhone SE and a 1440
// desk: an invoice's pay code full screen (big, black on white, the
// amount, the first name, the words to scan), saved as a picture and an
// SVG, opened by the customer's phone (Barta's name and what's due first)
// and paid through the practice Checkout, then on the invoice's history;
// Collect payment on a visit of a customer Rotor still bills says why there
// is no code; Signs & flyers: the Menu tile, the list with its numbers, a
// new code, its print pictures, a real scan of /q/ landing on the quote
// page with the source, and a technician kept out. `npm run e2e`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { start } from "./server.mjs";
import { seedQr } from "./qr-seed.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, badLinks, screenProblems, shot, noInstallCard } from "./kit.mjs";

let srv, browser, seeded, M, Q;
before(async () => { srv = await start(); seeded = await srv.seed(); M = seeded.money; Q = await seedQr(srv.url, seeded); browser = await launch(); });
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
const viewHas = (f, re, timeout = 15000) => f.waitForFunction((src) => new RegExp(src).test(document.getElementById("view").textContent + ((document.getElementById("pane") || {}).textContent || "")), re.source, { timeout });
const post = async (p, path, data = {}) => (await p.ctx.request.post("/api/crm" + path, { headers: { "x-crm": "1", "content-type": "application/json" }, data })).json();
// a sheet that has finished sliding or fading in (screenshots and sizes after the transition)
const sheetSettled = (f) => f.waitForFunction(() => { const s = document.querySelector(".sheet.on"); if (!s) return false; const c = getComputedStyle(s); return c.opacity === "1" && (c.transform === "none" || c.transform === "matrix(1, 0, 0, 1, 0, 0)"); }, null, { timeout: 5000 });
const toastHas = (f, re) => f.waitForFunction((src) => [...document.querySelectorAll(".toast")].some((x) => new RegExp(src).test(x.textContent)), re.source, { timeout: 10000 });
// the code on screen: square, inside the screen, as big as the device allows
const codeBox = (f) => f.$eval(".sheet.on .mn-scan-code svg", (s) => { const b = s.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top), bottom: Math.round(b.bottom), vw: innerWidth, vh: innerHeight }; });
const portalProblems = (page) => page.evaluate(() => {
  const out = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
  for (const el of document.querySelectorAll("main a, main button")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest("[hidden]")) continue;
    const box = el.closest("label") ? el.closest("label").getBoundingClientRect() : r;
    if (box.height < 43.5 || box.width < 43.5) out.push(`small tap target ${el.tagName.toLowerCase()} "${(el.textContent || "").trim().slice(0, 24)}"`);
  }
  return out;
});
async function download(page, f, sel) {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), f.click(sel)]);
  const path = await dl.path();
  return { name: dl.suggestedFilename(), bytes: readFileSync(path) };
}
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngSize = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

for (const device of ["iphone13", "iphonese", "desk1440"]) {
  const desk = device.startsWith("desk");

  test(`scan to pay (${device}): Show QR to pay full screen, saved for a printed invoice, scanned and paid on the customer's phone, then on the invoice's history`, async () => {
    const { p, page, f } = await open("olive", device);
    const cust = await phone(browser, srv, { device: desk ? "iphone13" : device });
    try {
      const inv = (await post(p, "/invoices", { contact_id: M.contacts.test, lines: [{ description: "Exterior window cleaning", unit_cents: 32500 }], issue: true, use_credit: false })).data.invoice;
      await goTo(f, `/invoices/${inv.id}`);
      await f.waitForSelector("[data-act=qr]", { timeout: 10000 });
      assert.match(await f.textContent("[data-act=qr]"), /Show QR to pay/);
      await f.click("[data-act=qr]");
      await f.waitForSelector(".sheet.on.mn-full .mn-scan-code svg", { timeout: 15000 });
      await sheetSettled(f);
      const sheetText = await f.textContent(".sheet.on");
      assert.match(sheetText, /\$325\.00/);
      assert.match(sheetText, new RegExp(`Terry · ${inv.number}`));
      assert.match(sheetText, /Scan with your phone camera to pay/);
      assert.match(sheetText, /The code works until [A-Z][a-z]{2} \d{1,2}, 20\d\d/);
      const box = await codeBox(f);
      assert.ok(Math.abs(box.w - box.h) <= 1, `square (${JSON.stringify(box)})`);
      assert.ok(box.w >= (desk ? 400 : 280) && box.w <= box.vw, `big enough to scan from arm's length (${JSON.stringify(box)})`);
      assert.ok(box.top >= 0 && box.bottom <= box.vh, `the whole code on screen without scrolling (${JSON.stringify(box)})`);
      // full screen and high contrast: the sheet covers the screen, black on white
      const look = await f.evaluate(() => { const s = document.querySelector(".sheet.on"); const r = s.getBoundingClientRect(); const svg = s.querySelector(".mn-scan-code svg"); return { top: Math.round(r.top), h: Math.round(r.height), vh: innerHeight, bg: getComputedStyle(s).backgroundColor, dark: svg.querySelector("path").getAttribute("fill"), light: svg.querySelector("rect").getAttribute("fill") }; });
      assert.deepEqual([look.top, look.h >= look.vh - 1, look.bg, look.dark, look.light], [0, true, "rgb(255, 255, 255)", "#000", "#fff"]);
      assert.deepEqual(await screenProblems(f), [], "the pay code passes the phone checks");
      await shot(page, `qr-pay-code-${device}`);
      // a picture and an SVG for a printed invoice
      const png = await download(page, f, ".sheet.on [data-qr-png]");
      assert.equal(png.name, `pay-${inv.number}.png`);
      assert.deepEqual([...png.bytes.subarray(0, 8)], PNG);
      assert.deepEqual(pngSize(png.bytes), { w: 1200, h: 1560 });
      const svg = await download(page, f, ".sheet.on [data-qr-svg]");
      assert.match(svg.bytes.toString("utf8"), /^<svg [\s\S]*Scan with your phone camera to pay<\/text>/);
      // not paid yet
      await f.click(".sheet.on [data-check]");
      await toastHas(f, /Not yet/);
      // the customer scans a code (the same kind of link) and pays on their phone
      const link = (await post(p, `/invoices/${inv.id}/pay-qr`)).data;
      await cust.page.goto(new URL(link.url).pathname);
      await cust.page.waitForURL(/\/p\/invoice\/in_/, { timeout: 10000 });
      await cust.page.waitForSelector("[data-scan]", { timeout: 10000 });
      const top = await cust.page.evaluate(() => { const s = document.querySelector("[data-scan]"); return { first: [...document.querySelector("main").children].find((e) => e.tagName !== "STYLE") === s, text: s.textContent, y: Math.round(s.getBoundingClientRect().top) }; });
      assert.equal(top.first, true, "the amount comes first");
      assert.match(top.text, /Barta Window Washing[\s\S]*for Terry[\s\S]*\$325\.00/);
      assert.ok(top.y < 120, "on screen as the page opens");
      assert.deepEqual(await portalProblems(cust.page), [], "the pay page from a scan passes the phone checks");
      await shot(cust.page, `qr-pay-page-${device}`);
      await cust.page.click("label.tip:has(input[value='10'])");
      await cust.page.click("[data-pay-btn]");
      await cust.page.waitForURL(/\/p\/dry-checkout\/dry_cs_/, { timeout: 15000 });
      await cust.page.click("[data-dry-act=pay][data-method=card]");
      await cust.page.waitForURL(/\/p\/return\?cs=/, { timeout: 15000 });
      await cust.page.waitForFunction(() => /Paid\. Thank you!/.test(document.querySelector("main").textContent), null, { timeout: 10000 });
      assert.deepEqual(cust.outside, [], "nothing reached another site (no Stripe in dry run)");
      // the office's "Did it go through?" sees it, and the invoice's history says how
      await f.click(".sheet.on [data-check]");
      await toastHas(f, /Paid\. Thank you!/);
      await viewHas(f, /Opened from the code/);
      const hist = await f.textContent(desk ? "#pane" : "#view");
      assert.match(hist, /Pay code shown/);
      assert.match(hist, /scanned the pay code/);
      assert.doesNotMatch(await f.evaluate((id) => document.getElementById(id).innerHTML, desk ? "pane" : "view"), /data-act="qr"/, "a paid invoice has no code to show");
      await shot(page, `qr-invoice-history-${device}`);
      // Rotor's own invoice: no button at all
      await goTo(f, `/invoices/${M.invoices.rotor}`);
      assert.equal(await f.$("[data-act=qr]"), null);
      assert.deepEqual(await badLinks(f), []);
      await p.clean();
      await cust.clean();
    } finally { await cust.close(); await p.close(); }
  });

  test(`scan to pay on Collect payment (${device}): a customer Rotor still bills gets the reason instead of a code`, async () => {
    const { p, page, f } = await open("theo", device);
    try {
      await goTo(f, `/visits/${Q.visits[device]}`);
      await f.waitForSelector("[data-vact='money.collect']", { timeout: 10000 });
      await f.click("[data-vact='money.collect']");
      await f.waitForSelector(".sheet.on [data-qr]", { timeout: 10000 });
      await f.click(".sheet.on [data-qr]");
      await f.waitForSelector(".sheet.on.mn-full [data-pay-qr-none]", { timeout: 15000 });
      await sheetSettled(f);
      const text = await f.textContent(".sheet.on");
      assert.match(text, /No code to scan/);
      assert.match(text, /Rotor still bills this customer, so paying by card opens after the switch\. Take cash or a check\./);
      assert.deepEqual(await screenProblems(f), [], "the reason passes the phone checks");
      await shot(page, `qr-collect-refused-${device}`);
      await f.click(".sheet.on [data-back]");
      await f.waitForSelector(".sheet.on [data-collect]", { timeout: 5000 });
      assert.equal(await f.$(".sheet.on.mn-full"), null, "back to the form, not full screen");
      await p.clean();
    } finally { await p.close(); }
  });

  test(`Signs & flyers (${device}): the Menu tile, the list with its numbers, a new code, its print pictures, a real scan of /q/, the leads`, async () => {
    const { p, page, f } = await open("olive", device);
    const visitor = await phone(browser, srv, { device: desk ? "iphone13" : device });
    try {
      await goTo(f, "/menu");
      assert.match(await f.textContent("#view"), /Sales[\s\S]*Signs & flyers/);
      await f.click("a.mtile[href='#/signs']");
      await settled(f, { hash: "#/signs" });
      assert.equal(await title(f), "Signs & flyers");
      let text = await f.textContent("#view");
      assert.match(text, /Yard sign, Maple Grove[\s\S]*Yard sign · Maple Grove · placed/);
      assert.match(text, /Door hanger, Oct/);
      assert.match(text, /All your codes/);
      assert.deepEqual(await screenProblems(f), [], "Signs & flyers passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `qr-signs-${device}`);
      // the Maple Grove sign: its numbers and its lead who booked and paid
      await f.click(`a[href="#/signs/${Q.codes.maple}"]`);
      await settled(f, { hash: `#/signs/${Q.codes.maple}` });
      text = await f.textContent("#view");
      assert.match(text, /Leads from it show as Yard sign: Maple Grove/);
      assert.match(text, /Quinn Signfolk[\s\S]*\$185\.00[\s\S]*Booked/);
      assert.match(text, /iPhone 6 · Android 3/);
      assert.deepEqual(await screenProblems(f), [], "one code passes the phone checks");
      await shot(page, `qr-sign-${device}`);
      // a new one
      await goTo(f, "/signs/new");
      assert.equal(await title(f), "New code");
      assert.deepEqual(await screenProblems(f), [], "the form passes the phone checks");
      await f.fill("input[name=name]", `Door hanger, Mound ${device}`);
      await f.selectOption("select[name=kind]", "door_hanger");
      await f.fill("input[name=area]", "Mound");
      await f.selectOption("select[name=dest_kind]", "page");
      await f.waitForSelector("[data-path]:not([hidden])");
      await f.fill("input[name=dest_path]", "/crm/");
      await f.click("button[type=submit]");
      await f.waitForSelector("[data-field='dest.path'].bad", { timeout: 10000 });
      assert.match(await f.textContent("[data-field='dest.path'] .why"), /Pick a page of the website/);
      await f.fill("input[name=dest_path]", "/services/gutter-cleaning.html");
      await shot(page, `qr-sign-new-${device}`);
      await f.click("button[type=submit]");
      await f.waitForFunction(() => /^#\/signs\/qr_/.test(location.hash), null, { timeout: 10000 });
      await settled(f);
      text = await f.textContent("#view");
      assert.match(text, /Door hanger: Mound/);
      const short = (await f.textContent(".sg-short")).trim();
      assert.match(short, /^bartawindowwashing\.com\/q\/[2-9a-hjkmnp-z]{8}$/);
      const slug = short.split("/").pop();
      const qrBox = await f.$eval(".sg-qr svg", (s) => { const b = s.getBoundingClientRect(); return { w: b.width, h: b.height }; });
      assert.ok(qrBox.w >= 200 && Math.abs(qrBox.w - qrBox.h) < 1);
      // the yard-sign picture: 18 × 24 at 100 px an inch; the flyer's SVG at its print size
      const sign = await download(page, f, "[data-print=sign][data-kind=png]");
      assert.equal(sign.name, `${slug}-yard-sign-18x24.png`);
      assert.deepEqual([...sign.bytes.subarray(0, 8)], PNG);
      assert.deepEqual(pngSize(sign.bytes), { w: 1800, h: 2400 });
      const flyer = await download(page, f, "[data-print=flyer][data-kind=svg]");
      assert.match(flyer.bytes.toString("utf8"), new RegExp(`width="4\\.25in" height="5\\.5in"[\\s\\S]*Door hanger, Mound[\\s\\S]*bartawindowwashing\\.com/q/${slug}`));
      // a real scan (the code's address on this server): the page, with the source, and the cookie for the quote form
      await visitor.page.goto(`/q/${slug}`);
      await visitor.page.waitForURL(new RegExp(`/services/gutter-cleaning\\.html\\?utm_source=qr&utm_medium=door_hanger&utm_campaign=${slug}$`), { timeout: 10000 });
      const ck = (await visitor.ctx.cookies()).find((c) => c.name === "barta_q");
      assert.ok(ck && ck.httpOnly && ck.value.startsWith(`${slug}.`), "the scan's cookie, for the quote form");
      const gone = await visitor.page.goto("/q/abcd2345");
      assert.equal(gone.status(), 404);
      assert.match(await visitor.page.textContent("main"), /This code isn't ours anymore/);
      // back on the code: one scan
      await f.evaluate(() => location.reload());
      const g = await crmFrame(page);
      await settled(g);
      await viewHas(g, /\b1\s*scan\b/);
      await p.clean();
      await visitor.clean({ allow: [/404/] });
    } finally { await visitor.close(); await p.close(); }
  });
}

test("Signs & flyers isn't a technician's", async () => {
  const { p, f } = await open("theo", "iphone13");
  try {
    await goTo(f, "/menu");
    assert.doesNotMatch(await f.textContent("#view"), /Signs & flyers/);
    await goTo(f, "/signs");
    assert.match(await f.textContent("#view"), /Not for this login/);
    const r = await p.ctx.request.get("/api/crm/qr-codes", { headers: { "x-crm": "1" } });
    assert.equal(r.status(), 403);
    await p.clean();
  } finally { await p.close(); }
});
