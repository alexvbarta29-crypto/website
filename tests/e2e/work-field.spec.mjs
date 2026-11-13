// Phone checks of the tech app (M4b; design §12.4, §9.3, §9.2 Timesheets):
// a tech's Today (the clock bar, the day in route order), working a visit
// from the field panel (on my way with the dry-run "send it yourself",
// the timer, the checklist, photos that keep their EXIF, notes, an upsell
// line, complete), Time and Pay; an owner who goes out on visits ("My
// visits"), and the office's Timesheets (approve a week, edit with a
// reason, decide on an entry waiting). iPhone 13 and iPhone SE sizes.
// `npm run e2e` (E2E_SHOTS=dir for screenshots). The offline flows are in
// offline.spec.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, badLinks, screenProblems, shot, noInstallCard } from "./kit.mjs";

let srv, browser, seeded;
before(async () => { srv = await start(); seeded = await srv.seed(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(login, device) {
  const p = await phone(browser, srv, { device });
  // the phone's clock reads the server's (the server's clock is pinned to a test day)
  await p.ctx.clock.install({ time: Date.parse(srv.now()) });
  await signIn(p, login);
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  return { p, page: p.page, f };
}
const toastSays = (f, re) => f.waitForFunction((src) => new RegExp(src).test((document.querySelector(".toasts") || {}).textContent || ""), re.source, { timeout: 8000 });
const sheetUp = (f, re) => f.waitForFunction((src) => { const h = document.querySelector(".sheet.on h2"); return !!h && new RegExp(src).test(h.textContent); }, re.source, { timeout: 5000 });
async function checks(f, page, name, problems) {
  for (const x of await screenProblems(f)) problems.push(`${name}: ${x}`);
  for (const x of await badLinks(f)) problems.push(`${name}: a link that leaves in this tab ${x}`);
  await shot(page, name);
}
const api = async (p, path, opts = {}) => {
  const res = await p.ctx.request.fetch("/api/crm" + path, { method: opts.method || "GET", headers: { "x-crm": "1", ...(opts.body ? { "content-type": "application/json" } : {}) }, ...(opts.body ? { data: opts.body } : {}) });
  return { status: res.status(), body: await res.json().catch(() => null), bytes: opts.bytes ? await res.body() : null };
};

// A real JPEG (made by the browser's canvas) with a synthetic EXIF segment
// (an ImageDescription marker and a sideways orientation) spliced in.
async function photoWithExif(page, width) {
  const b64 = await page.evaluate(async (w) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = 120;
    const g = c.getContext("2d");
    g.fillStyle = "#fb4d3d"; g.fillRect(0, 0, w, 120); g.fillStyle = "#16161b"; g.fillRect(20, 20, 80, 80);
    return c.toDataURL("image/jpeg", 0.8).split(",")[1];
  }, width);
  const jpeg = Buffer.from(b64, "base64");
  const desc = Buffer.from("SYNTHETIC-EXIF-GPS-45.0419N\0", "latin1");
  // TIFF (little endian): IFD0 with Orientation = 6 and ImageDescription → desc
  const ifd = Buffer.alloc(2 + 2 * 12 + 4);
  ifd.writeUInt16LE(2, 0);
  ifd.writeUInt16LE(0x010e, 2); ifd.writeUInt16LE(2, 4); ifd.writeUInt32LE(desc.length, 6); ifd.writeUInt32LE(8 + ifd.length, 10);
  ifd.writeUInt16LE(0x0112, 14); ifd.writeUInt16LE(3, 16); ifd.writeUInt32LE(1, 18); ifd.writeUInt16LE(6, 22);
  const tiff = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]), ifd, desc]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}
async function snap(page, f, selector, buffer) {
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), f.click(selector)]);
  await fc.setFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer });
}

for (const device of ["iphone13", "iphonese"]) {
  test(`a tech's day (${device}): Today, clock in, work a visit from start to done, Time and Pay`, async () => {
    const login = device === "iphone13" ? "theo" : "tess";
    const me = device === "iphone13" ? seeded.users.tech : seeded.users.tech2;
    const visitId = device === "iphone13" ? seeded.visits[0] : seeded.visits[1];
    const { p, page, f } = await open(login, device);
    const problems = [];
    try {
      // Today: the clock bar and the day in route order
      assert.equal(await title(f), "Today");
      await f.waitForSelector(".tf-clock");
      await f.waitForSelector(`.tf-stop a[href="#/visits/${visitId}"]`);
      assert.match(await f.textContent(".tf-today"), /Not clocked in/);
      assert.ok(await f.$(".tf-stop .tf-quick a[href^='tel:']"), "Call");
      assert.ok(await f.$(".tf-stop .tf-quick a[href^='sms:']"), "Text");
      assert.ok(await f.$(".tf-stop .tf-quick a[data-external='top'], .tf-stop .tf-quick a[target='_blank']"), "Directions leave the CRM");
      assert.doesNotMatch(await f.textContent("#view"), /No visits today/, "the placeholder is gone");
      await checks(f, page, `field-today-${device}`, problems);
      await f.click("[data-day]:nth-child(3)");                          // tomorrow
      await f.waitForFunction(() => /Tomorrow/.test(document.querySelector(".tf-dayline").textContent));
      await f.click("[data-day]:nth-child(2)");
      await f.waitForFunction(() => /Today/.test(document.querySelector(".tf-dayline").textContent));
      await f.click("[data-clock=in]");
      await toastSays(f, /Clocked in/);
      await f.waitForSelector(".tf-clock.on");
      await checks(f, page, `field-today-clocked-${device}`, problems);

      // the visit: the field panel
      await f.click(`.tf-stop a[href="#/visits/${visitId}"]`);
      await settled(f, { hash: `#/visits/${visitId}` });
      await f.waitForSelector("[data-panel=field] .tf-state");
      assert.equal(await f.$("[data-move]"), null, "no office buttons for a tech");
      assert.equal(await f.$$eval(".wk-check", (x) => x.length), 0, "the panel shows the checklist itself");
      await checks(f, page, `field-visit-${device}`, problems);

      // on my way: texts aren't switched on, so the words to send by hand
      await f.click("[data-omw]");
      await sheetUp(f, /On my way/);
      await checks(f, page, `field-omw-sheet-${device}`, problems);
      await f.fill(".sheet [name=n]", "15");
      await f.click(".sheet [type=submit]");
      await f.waitForSelector(".tf-sent a[href^='sms:']", { timeout: 8000 });
      assert.match(await f.getAttribute(".tf-sent a[href^='sms:']", "href"), /about%2015%20minutes/);
      assert.match(await f.textContent(".tf-state h2"), /On the way/);
      await checks(f, page, `field-omw-sent-${device}`, problems);

      // start, tick, photos, a note, an upsell line, complete
      await f.click("[data-timer=start]");
      await f.waitForSelector("[data-timer=pause]");
      await f.click("[data-item=gate_closed]");
      await f.waitForSelector("[data-item=gate_closed][aria-pressed=true]");
      const small = await photoWithExif(f, 400);
      await snap(page, f, "[data-item=walkaround_photo]", small);
      await f.waitForSelector("[data-item=walkaround_photo][aria-pressed=true]", { timeout: 15000 });
      const wide = await photoWithExif(f, 2400);
      await snap(page, f, "[data-item=after_photo]", wide);
      await f.waitForSelector("[data-item=after_photo][aria-pressed=true]", { timeout: 15000 });
      assert.equal(await f.$$eval(".tf-photo img", (x) => x.length), 2);
      await f.fill("[data-note-form] textarea", "Synthetic: the back gate sticks.");
      await f.click("[data-note-form] [type=submit]");
      await f.waitForFunction(() => /back gate sticks/.test(document.querySelector("[data-panel=field]").textContent));
      await checks(f, page, `field-working-${device}`, problems);
      await f.click("[data-addline]");
      await sheetUp(f, /Add to the job/);
      await checks(f, page, `field-addline-${device}`, problems);
      await f.click(".sheet [data-pick]");
      await f.fill(".sheet [name=qty]", "4");
      await f.click(".sheet [type=submit]");
      await toastSays(f, /Added to the job/);
      await f.waitForFunction(() => /Added on site/.test(document.querySelector("[data-panel=field]").textContent));
      await f.click("[data-complete]");
      await f.waitForSelector(".tf-done", { timeout: 8000 });
      await checks(f, page, `field-done-${device}`, problems);

      // the server has it all, and the photos kept their EXIF
      const v = (await api(p, `/visits/${visitId}`)).body.data.visit;
      assert.equal(v.status, "completed");
      assert.equal(v.photos.length, 2);
      assert.ok(v.checklist.items.filter((i) => i.required).every((i) => i.done_at), "every required item done");
      for (const ph of v.photos) {
        const file = await api(p, `/files/${ph.file_id}`, { bytes: true });
        assert.equal(file.status, 200);
        const bytes = file.bytes;
        assert.ok(bytes.includes(Buffer.from("SYNTHETIC-EXIF-GPS-45.0419N", "latin1")), "the EXIF came through");
      }
      const shrunk = (await api(p, `/files/${v.photos.find((x) => x.item === "after_photo").file_id}`, { bytes: true })).bytes;
      const at = shrunk.indexOf(Buffer.from("Exif\0\0", "latin1"));
      assert.ok(at > 0 && shrunk.length < wide.length * 4, "the wide photo was shrunk, with its EXIF put back");
      const o = shrunk.indexOf(Buffer.from([0x12, 0x01, 0x03, 0x00]), at);
      assert.equal(shrunk[o + 8], 1, "upright: its pixels were drawn upright");

      // Time and Pay
      await goTo(f, "/time");
      await f.waitForSelector(".tf-total");
      assert.match(await f.textContent("#view"), /On the clock/);
      await checks(f, page, `field-time-${device}`, problems);
      await goTo(f, "/pay");
      await f.waitForSelector(".tf-money");
      assert.match(await f.textContent("#view"), /Estimate/);
      await checks(f, page, `field-pay-${device}`, problems);
      await goTo(f, "/me");
      await checks(f, page, `field-me-${device}`, problems);
      assert.deepEqual(problems, []);
      await p.clean();
      void me;
    } finally { await p.close(); }
  });
}

test("the office: Timesheets (approve a week, edit with a reason, decide on an entry waiting) and My visits for an owner who goes out", async () => {
  // a few shifts first, made the way the phones make them
  const tech = await phone(browser, srv);
  await signIn(tech, "theo");
  const post = (path, body) => tech.ctx.request.post("/api/crm" + path, { headers: { "x-crm": "1", "content-type": "application/json" }, data: { client_id: randomUUID(), client_at: srv.now(), ...body } });
  const now = Date.parse(srv.now());
  let r = await post("/clock", { action: "out" });                      // whatever the other test left open
  // an early shift a phone kept with no signal (05:00 to 06:00 by its clock), replayed after the day's shift began:
  // it waits as an overlap until its end is known, then it's an ordinary shift again
  const inId = randomUUID();
  const at = (h) => new Date(now - h * 3600000).toISOString();
  r = await post("/clock", { action: "in", client_id: inId, queued_offline: true, client_at: at(5), queued_at: at(5) });
  assert.ok([200, 201, 202].includes(r.status()), await r.text());
  r = await post("/clock", { action: "out", shift_client_id: inId, queued_offline: true, client_at: at(4), queued_at: at(4) });
  assert.ok([200, 202].includes(r.status()), await r.text());
  assert.equal(JSON.parse(await r.text()).data.closed.status, "closed", "no overlap once its end is known");
  // and one the server couldn't take on its own (queued long after the claimed time)
  const tess = await phone(browser, srv);
  await signIn(tess, "tess");
  await tess.ctx.request.post("/api/crm/clock", { headers: { "x-crm": "1", "content-type": "application/json" }, data: { action: "out", client_id: randomUUID(), client_at: srv.now() } });
  const tessIn = randomUUID();
  r = await tess.ctx.request.post("/api/crm/clock", { headers: { "x-crm": "1", "content-type": "application/json" }, data: { action: "in", client_id: tessIn, queued_offline: true, client_at: at(7), queued_at: at(6.5) } });
  assert.ok([200, 201, 202].includes(r.status()), await r.text());
  r = await tess.ctx.request.post("/api/crm/clock", { headers: { "x-crm": "1", "content-type": "application/json" }, data: { action: "out", client_id: randomUUID(), shift_client_id: tessIn, queued_offline: true, client_at: at(6), queued_at: at(6) } });
  assert.ok([200, 202].includes(r.status()), await r.text());
  assert.equal(JSON.parse(await r.text()).data.closed.pending.reason, "queued_mismatch", "it waits because of its time, not an overlap that wasn't one");
  await tech.close(); await tess.close();

  const { p, page, f } = await open("olive", "iphonese");
  const problems = [];
  try {
    // an owner who goes out on visits: My visits and the clock on Home, and they work there (the card's own buttons)
    await f.waitForSelector(".hm-extra .tf-clock");
    assert.match(await f.textContent("#view"), /My visits/);
    await f.click(".hm-extra [data-day]:nth-child(3)");
    await f.waitForFunction(() => /Tomorrow, /.test((document.querySelector(".hm-extra .tf-dayline") || {}).textContent || ""));
    await f.click(".hm-extra [data-day]:nth-child(2)");
    await f.waitForFunction(() => /Today, /.test((document.querySelector(".hm-extra .tf-dayline") || {}).textContent || ""));
    await checks(f, page, "field-owner-today-iphonese", problems);
    // the Menu has Time, Pay and Timesheets (Work)
    await f.click('#tabs [data-tab="menu"]');
    await f.waitForSelector(".menu-sheet.on");
    const labels = await f.$$eval(".menu-sheet .ms-l", (els) => els.map((e) => e.textContent));
    for (const want of ["Time", "Pay", "Timesheets"]) assert.ok(labels.includes(want), `the Menu lists ${want}`);
    await f.click('.menu-sheet a[href="#/timesheets"]');
    await settled(f, { hash: "#/timesheets" });
    await f.waitForSelector(`[data-approve="${seeded.users.tech.id}"]`);
    await f.waitForSelector("[data-decide]");
    await checks(f, page, "field-timesheets-iphonese", problems);
    // decide on Tess's waiting entry: approve as claimed
    await f.click("[data-decide]");
    await sheetUp(f, /Decide on this entry/);
    await checks(f, page, "field-timesheets-decide-iphonese", problems);
    await f.click(".sheet [type=submit]");
    await toastSays(f, /Approved/);
    // edit one of Theo's: a reason is required
    await f.click(`.card:has([data-approve="${seeded.users.tech.id}"]) [data-edit]`);
    await sheetUp(f, /Edit this entry/);
    const endWas = await f.inputValue(".sheet [name=end]");
    const [h, m] = endWas.split(":").map(Number);
    const t15 = h * 60 + m >= 15 ? h * 60 + m - 15 : h * 60 + m + 15;          // a quarter hour earlier (or later at midnight)
    await f.fill(".sheet [name=end]", `${String(Math.floor(t15 / 60)).padStart(2, "0")}:${String(t15 % 60).padStart(2, "0")}`);
    await f.click(".sheet [type=submit]");
    await toastSays(f, /Say why/);
    await f.fill(".sheet [name=reason]", "Synthetic: left at the last stop.");
    await f.click(".sheet [type=submit]");
    await toastSays(f, /Saved/);
    await f.waitForSelector(`[data-approve="${seeded.users.tech.id}"]`);
    await f.click(`[data-approve="${seeded.users.tech.id}"]`);
    await sheetUp(f, /Approve the week/);
    await f.click(".sheet [data-a=yes]");
    await toastSays(f, /approved/);
    const week = (await api(p, "/timesheets")).body.data;
    const theo = week.weeks.find((w) => w.user_id === seeded.users.tech.id);
    assert.ok(theo.entries.some((e) => e.st === "approved" && e.ed), "edited, then approved");
    assert.equal(week.pending.length, 0, "nothing waiting");
    await checks(f, page, "field-timesheets-done-iphonese", problems);
    await goTo(f, "/time");
    await f.waitForSelector(".tf-total");
    await checks(f, page, "field-owner-time-iphonese", problems);
    assert.deepEqual(problems, []);
    await p.clean();
  } finally { await p.close(); }
});
