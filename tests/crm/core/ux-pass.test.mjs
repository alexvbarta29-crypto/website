// The brand red and the UX pass (Nov 2026): the logo red is the one filled red, white words on it are
// large text, a form route hides the bar, one "..." per header, plain words for template keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../../crm-app/styles/crm.css", import.meta.url), "utf8");

test("every filled brand red is the logo's #fb4d3d, and the status red stays apart", () => {
  const root = css.slice(0, css.indexOf("html:not([data-theme=\"light\"]) body.crm"));
  assert.match(root, /--coral:#fb4d3d;/);
  assert.match(root, /--coral-btn:#fb4d3d;/);
  assert.match(root, /--fab-red:#fb4d3d;/);
  assert.match(root, /--red-ink:#b42318;/, "errors keep their own red");
  for (const old of ["#db3a29", "#ef4b32", "#c7311f", "#e5483a", "rgba(199,49,31"]) assert.ok(!css.includes(old), `no ${old} left in crm.css`);
});

test("white words on the red are bold and 17 px (large text: 3.4:1 passes)", () => {
  assert.match(css, /\.btn\.primary\{[^}]*font-weight:700;font-size:var\(--t-lg\)/);
  assert.match(css, /\.rs-pb\.red,\.rs-pb\.red\.wide,[^{]*\{font-weight:700;font-size:var\(--t-lg\)\}\s*$/m);
  assert.match(css, /--t-lg:17px;/);
});

test("a template key reads as the template's name; an unknown key as words", async () => {
  const { plainAction } = await import("../../../crm-app/modules/system/automations.js");
  const tpls = [{ key: "visit_confirm", name: "Visit booked" }];
  assert.equal(plainAction("Text visit_confirm", tpls), 'Text "Visit booked"');
  assert.equal(plainAction("Text lead_ack", tpls), "Text lead ack");
  assert.equal(plainAction("Text + email", tpls), "Text + email");
  assert.equal(plainAction(undefined, tpls), "");
});

test("a new template's key comes from its name and always passes the server's rule", async () => {
  const { keyFrom } = await import("../../../crm-app/modules/system/template.js");
  const RE = /^[a-z][a-z0-9_]{1,39}$/;
  assert.equal(keyFrom("Spring gutter reminder"), "spring_gutter_reminder");
  for (const n of ["2nd visit, café!", "x", "", "  ", "a".repeat(80), "Été <b>bold</b>", "___"]) assert.match(keyFrom(n), RE, JSON.stringify(n));
});

test("the form routes: new and edit screens, not lists or details", async () => {
  const src = readFileSync(new URL("../../../crm-app/core/nav.js", import.meta.url), "utf8");
  const FORM_PATH = new RegExp(src.match(/export const FORM_PATH = \/(.+)\/;/)[1]);
  for (const p of ["/quotes/new", "/jobs/new/ct_01m7n0b8dk", "/contacts/ct_01m7n0b8dk/edit", "/quotes/qt_1/edit", "/inbox/new", "/requests/new"]) assert.ok(FORM_PATH.test(p), p);
  for (const p of ["/quotes", "/jobs/jb_1", "/contacts/ct_1", "/newsletter", "/settings/new-things", "/today"]) assert.ok(!FORM_PATH.test(p), p);
});

test("one \"...\": the section's rows ride in the screen's own sheet once, without repeats", async () => {
  const ui = await import("../../../crm-app/core/ui.js");
  assert.equal(typeof ui.armMoreExtra, "function");
  ui.setMoreExtra([{ label: "Outbox", href: "#/outbox" }, { label: "Manage pipelines", href: "#/settings/cadences" }]);
  assert.equal(ui.hasMoreExtra(), true);
  ui.setMoreExtra([]);
  assert.equal(ui.hasMoreExtra(), false);
  assert.match(css, /\.app\.own-more-ph \.sec-more/);
});
