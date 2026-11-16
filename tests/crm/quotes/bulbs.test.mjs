// The lights mockup's drawing math (crm-app/modules/quotes/bulbs.js, ported
// from Light Studio): bulbs placed along the marked polylines (spacing, one
// bulb on a shared corner or peak, upright on the wire),
// net lights inside a bush, and the edge finder the app falls back to when
// Claude can't mark the house (a synthetic house; a blank photo gives up).
import { test } from "node:test";
import assert from "node:assert/strict";

const B = await import("../../../crm-app/modules/quotes/bulbs.js");

test("bulbs along a straight eave: evenly spaced at Light Studio's C9 spacing, both ends lit, upright on the wire", () => {
  const w = 640, h = 480, u = Math.hypot(w, h) / 1000;
  const lines = [{ kind: "eave", points: [[100, 200], [540, 200]] }];
  const bulbs = B.placeBulbs(lines, { w, h, size: 1, palette: "warm" });
  const spacing = B.C9.spacing * u;
  assert.equal(bulbs.length, Math.round(440 / spacing) + 1);
  const xs = bulbs.map((b) => b.x);
  assert.ok(Math.abs(xs[0] - 100) < 0.01 && Math.abs(xs[xs.length - 1] - 540) < 0.01, "both ends");
  const gaps = xs.slice(1).map((x, i) => x - xs[i]);
  assert.ok(gaps.every((g) => Math.abs(g - gaps[0]) < 1e-6) && Math.abs(gaps[0] - spacing) < 0.5, "even, about one spacing apart");
  assert.ok(bulbs.every((b) => b.y < 200 && b.y > 196), "upright C9s just above the wire, as clipped on a gutter (Light Studio's look)");
  assert.ok(bulbs.every((b) => b.hex === B.COLORS.warm));
  // bigger bulbs: fewer of them, farther apart
  assert.ok(B.placeBulbs(lines, { w, h, size: 1.3 }).length < bulbs.length);
});

test("a gable (two runs meeting at the peak) and a corner shared with the eave get one bulb each; multicolor cycles", () => {
  const w = 640, h = 480;
  const lines = [{ kind: "eave", points: [[100, 260], [540, 260]] }, { kind: "rake", points: [[100, 260], [320, 150], [540, 260]] }];
  const runs = B.runsOf(lines, { w, h, palette: "multi" });
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map((r) => [!!r.skipA, !!r.skipB]), [[false, false], [true, false], [true, true]], "the left corner, the peak and the right corner are drawn once");
  const bulbs = B.placeBulbs(lines, { w, h, palette: "multi" });
  const near = (x, y) => bulbs.filter((b) => Math.hypot(b.x - x, b.y - y) < 3).length;
  assert.equal(near(320, 150), 1, "one bulb at the peak");
  assert.equal(near(100, 260), 1, "one bulb at the shared corner");
  assert.deepEqual([...new Set(bulbs.map((b) => b.hex))].sort(), B.paletteColors("multi").map((c) => B.COLORS[c]).sort());
  // junk points are skipped, not drawn at 0,0
  assert.equal(B.placeBulbs([{ kind: "eave", points: [[10, 10], [NaN, 2], null] }], { w, h }).length, 0);
});

test("bushes and trees: net lights inside the traced shape only", () => {
  const pts = [[100, 300], [200, 300], [200, 380], [100, 380]];
  const bulbs = B.placeBulbs([{ kind: "bush", points: pts }], { w: 640, h: 480 });
  assert.ok(bulbs.length > 20);
  assert.ok(bulbs.every((b) => B.inPoly(b.x, b.y, pts)));
  assert.deepEqual(B.placeBulbs([{ kind: "bush", points: pts }], { w: 640, h: 480 }).map((b) => b.x), bulbs.map((b) => b.x), "the same every time (seeded by the shape)");
});

// A 320 x 240 street photo: sky, a gable roof, the wall, the lawn.
function house() {
  const w = 320, h = 240;
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 205 + ((x * 7 + y * 13) % 9) - 4;
    if (y > 125 && x >= 50 && x <= 270) v = 150 + ((x * 3 + y * 5) % 7) - 3;
    if (y > 200) v = 90;
    if (y <= 125 && y >= 65 && Math.abs(x - 160) <= ((y - 65) / 60) * 110) v = 60 + ((x + y) % 5);
    g[y * w + x] = v;
  }
  return { g, w, h };
}

test("the edge finder: the eave over the wall (not the lawn) and the gable's peak; a blank photo gives up", () => {
  const { g, w, h } = house();
  const got = B.detectRoofline(g, w, h);
  assert.ok(got, "found");
  const eave = got.lines.find((l) => l.kind === "eave");
  assert.ok(Math.abs(eave.points[0][1] - 125) <= 3 && Math.abs(eave.points[1][1] - 125) <= 3, `eave at the roof's bottom edge: ${JSON.stringify(eave.points)}`);
  assert.ok(eave.points[0][0] <= 60 && eave.points[1][0] >= 260, "across the house");
  const rake = got.lines.find((l) => l.kind === "rake");
  assert.ok(rake, "the gable");
  assert.ok(Math.abs(rake.points[1][0] - 160) <= 4 && Math.abs(rake.points[1][1] - 65) <= 4, `the peak: ${JSON.stringify(rake.points[1])}`);
  assert.ok(got.score > 0.5);
  assert.equal(B.detectRoofline(new Float32Array(w * h).fill(128), w, h), null);
  assert.equal(B.detectRoofline(null, w, h), null);
  // toGray: RGBA to luma
  assert.deepEqual([...B.toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1)].map(Math.round), [255, 0]);
});
