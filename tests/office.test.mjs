// /office — one page with tabs for the office tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

const office = (await import("../netlify/functions/office.mjs")).default;
const { TOOLS } = await import("../netlify/lib/office-page.mjs");

test("office page lists every tool and is never indexed", async () => {
  const res = await office(new Request("https://x.test/office"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  const body = await res.text();
  for (const t of TOOLS) assert.match(body, new RegExp(`data-tool="${t.id}"`));
  assert.match(body, /Christmas Lights/);
  assert.match(body, /Follow-ups/);
});

test("every tab points at a page that exists", () => {
  for (const t of TOOLS) {
    if (t.src === "/lights") assert.ok(existsSync("netlify/functions/lights.mjs"));
    else if (t.src === "/playbook") assert.ok(existsSync("netlify/functions/playbook.mjs"));
    else assert.ok(existsSync("." + t.src), t.src);
  }
});
