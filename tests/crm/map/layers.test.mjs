// The map's layers and filters (guide-gaps M3-M5, S21): customers, former
// customers and leads as layers; the lead source, the service and when they
// came in as filters (pure, on the phone); inactive areas as their own layer.
import { test } from "node:test";
import assert from "node:assert/strict";

test("placesShown: layers and filters", async () => {
  const K = await import("../../../crm-app/modules/map/knock.js");
  const places = [
    { k: "customer", src: "Referral", svc: "Windows", ca: "2026-11-10" }, { k: "former", src: "Google", svc: "Gutters", ca: "2025-01-10" },
    { k: "lead", src: "Referral", ca: "2026-11-15" }, { k: "customer", src: "Google", svc: "Windows", ca: "2024-06-01" },
  ];
  const all = { customers: true, former: true, leads: true, days: 0, src: "", svc: "" };
  const n = (f) => K.placesShown(places, { ...all, ...f }, "2026-11-17").length;
  assert.equal(n({}), 4);
  assert.equal(n({ former: false }), 3, "the former customers' layer");
  assert.equal(n({ customers: false, leads: false }), 1);
  assert.equal(n({ src: "Referral" }), 2);
  assert.equal(n({ svc: "Windows" }), 2);
  assert.equal(n({ days: 30 }), 2, "came in during the last 30 days");
});
