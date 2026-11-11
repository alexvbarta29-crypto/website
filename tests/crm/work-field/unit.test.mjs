// Pure pieces of the tech app (design §12.2): photos keep their EXIF
// (camera.js, the owner's rule), the forgotten timer's deadline, the day
// list's names and badges, Delano times on a phone in another zone.
import { test } from "node:test";
import assert from "node:assert/strict";

const cam = await import("../../../crm-app/core/camera.js");
const TM = await import("../../../netlify/lib/crm/modules/work/timers.mjs");
const DAY = await import("../../../netlify/lib/crm/modules/work/techday.mjs");
const TF = await import("../../../netlify/lib/crm/modules/work/types-field.mjs");
const kit = await import("../../../crm-app/modules/work/tech-kit.js");

// A synthetic JPEG: SOI, an Exif APP1 (little or big endian, orientation 6,
// an ImageDescription marker), an XMP APP1, the image data, EOI.
function exifJpeg({ le = true } = {}) {
  const u16 = (n) => (le ? [n & 255, n >> 8] : [n >> 8, n & 255]);
  const u32 = (n) => (le ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const desc = [...Buffer.from("SYNTHETIC-GPS\0", "latin1")];
  const ifd = [...u16(2), ...u16(0x010e), ...u16(2), ...u32(desc.length), ...u32(8 + 2 + 24 + 4), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(6), 0, 0, ...u32(0)];
  const tiff = [...(le ? [0x49, 0x49, 0x2a, 0x00] : [0x4d, 0x4d, 0x00, 0x2a]), ...u32(8), ...ifd, ...desc];
  const exif = [...Buffer.from("Exif\0\0", "latin1"), ...tiff];
  const xmp = [...Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>synthetic</x:xmpmeta>", "latin1")];
  const seg = (m, body) => [0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  return new Uint8Array([0xff, 0xd8, ...seg(0xe1, exif), ...seg(0xe1, xmp), ...seg(0xdb, [0, 1, 2, 3]), 0xff, 0xda, 0, 4, 9, 9, 1, 2, 3, 0xff, 0xd9]);
}
// What a canvas encoder gives: SOI, JFIF APP0, tables, data, EOI (no metadata).
const encoded = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 7, 0x4a, 0x46, 0x49, 0x46, 0, 0xff, 0xdb, 0, 4, 7, 7, 0xff, 0xda, 0, 4, 1, 1, 5, 6, 0xff, 0xd9]);
const orientation = (bytes) => {
  const segs = cam.jpegSegments(bytes).filter((s) => s.marker === 0xe1);
  const b = bytes.subarray(segs[0].start + 10);              // the TIFF header
  const le = b[0] === 0x49;
  const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const ifd = le ? b[4] : b[7];
  for (let k = 0; k < u16(ifd); k++) { const e = ifd + 2 + k * 12; if (u16(e) === 0x0112) return u16(e + 8); }
  return null;
};

test("camera.js keeps a photo's EXIF and XMP when it shrinks it, upright; a JPEG with none, or not a JPEG, is left as encoded", () => {
  for (const le of [true, false]) {
    const original = exifJpeg({ le });
    assert.equal(orientation(original), 6);
    const out = cam.keepExif(original, encoded());
    assert.deepEqual([...out.subarray(0, 2)], [0xff, 0xd8]);
    const segs = cam.jpegSegments(out);
    assert.deepEqual(segs.map((s) => s.marker), [0xe0, 0xe1, 0xe1, 0xdb], "JFIF, then Exif and XMP, then the encoder's tables");
    assert.ok(Buffer.from(out).includes(Buffer.from("SYNTHETIC-GPS", "latin1")), "the EXIF is there");
    assert.ok(Buffer.from(out).includes(Buffer.from("<x:xmpmeta>", "latin1")), "the XMP is there");
    assert.equal(orientation(out), 1, "upright: the canvas drew the pixels upright");
    assert.equal(orientation(original), 6, "the original is untouched");
    assert.deepEqual([...out.subarray(out.length - 2)], [0xff, 0xd9]);
  }
  const plain = cam.keepExif(encoded(), encoded());
  assert.deepEqual([...plain], [...encoded()], "no metadata to keep");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.deepEqual([...cam.keepExif(png, encoded())], [...encoded()]);
  assert.deepEqual(cam.jpegSegments(png), []);
  // a broken length never runs off the end
  assert.deepEqual(cam.jpegSegments(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1])), []);
});

test("a forgotten timer's deadline: visit end + 2 h, never before its planned length + 2 h; 20:00 with no visit; a done visit's end", () => {
  const v = { status: "in_progress", start_utc: "2026-11-17T14:00:00.000Z", end_utc: "2026-11-17T16:00:00.000Z" };
  const at = (iso) => new Date(TM.timerDeadline({ start_at: iso }, v, {})).toISOString();
  assert.equal(at("2026-11-17T13:50:00.000Z"), "2026-11-17T18:00:00.000Z", "the visit's end + 2 h");
  assert.equal(at("2026-11-17T14:05:00.000Z"), "2026-11-17T18:05:00.000Z", "a few minutes late: its planned 2 hours + 2");
  assert.equal(at("2026-11-17T17:00:00.000Z"), "2026-11-17T21:00:00.000Z", "started late: two planned hours + 2");
  assert.equal(new Date(TM.timerDeadline({ start_at: "2026-11-17T14:00:00.000Z" }, v, { timer_autoclose_after_min: 60 })).toISOString(), "2026-11-17T17:00:00.000Z", "the setting");
  assert.equal(new Date(TM.timerDeadline({ start_at: "2026-11-17T14:00:00.000Z" }, null)).toISOString(), "2026-11-18T02:00:00.000Z", "20:00 in Delano");
  assert.equal(new Date(TM.timerDeadline({ start_at: "2026-11-18T02:30:00.000Z" }, null)).toISOString(), "2026-11-18T04:30:00.000Z", "after 20:00: 2 hours on");
  assert.equal(new Date(TM.timerDeadline({ start_at: "2026-11-17T14:00:00.000Z" }, { ...v, status: "completed", completion: { at: "2026-11-17T15:30:00.000Z" } })).toISOString(), "2026-11-17T15:30:00.000Z");
  assert.equal(TM.minutesWorked([{ end_at: "x", minutes: 30 }, { end_at: "x", minutes: 0 }, { minutes: 99 }, { end_at: "x", minutes: 15 }]), 45, "open and under-a-minute segments don't count");
});

test("types: minutes are derived and never negative; an open shift has no end; a timer row for the office", () => {
  const ts = TF.validateTimesheet({ user_id: "us_0000000000000000000a", start_at: "2026-11-17T14:00:00Z", end_at: "2026-11-17T22:10:30Z", status: "closed" });
  assert.equal(ts.minutes, 491);
  assert.throws(() => TF.validateTimesheet({ user_id: "us_0000000000000000000a", start_at: "2026-11-17T14:00:00Z", end_at: "2026-11-17T13:00:00Z", status: "closed" }), /after it starts/);
  assert.throws(() => TF.validateTimesheet({ user_id: "us_0000000000000000000a", start_at: "2026-11-17T14:00:00Z", end_at: "2026-11-17T15:00:00Z", status: "open" }), /open shift/);
  assert.equal(TF.validateTimesheet({ user_id: "us_0000000000000000000a", start_at: "2026-11-17T14:00:00Z", status: "some_future_state" }, { op: "update" }).status, "some_future_state", "a stored value this code doesn't know is kept");
  assert.equal(TF.sheetShard({ start_at: "2026-12-01T03:00:00.000Z" }), "2026-11", "the local month of the start");
  const row = TF.timerRow({ visit_id: "vs_0000000000000000000a", user_ids: ["us_0000000000000000000a"], start_at: "2026-11-17T14:00:00.000Z" });
  assert.deepEqual(Object.keys(row).sort(), ["d", "j", "s", "u", "un", "v"]);
});

test("the day list: first name and last initial, the badges", () => {
  assert.equal(DAY.shortName({ display_name: "Pat Sample" }), "Pat S.");
  assert.equal(DAY.shortName({ display_name: "Pat van der Sample" }), "Pat S.");
  assert.equal(DAY.shortName({ display_name: "Cher" }), "Cher");
  assert.equal(DAY.shortName(null), "Customer");
  const b = DAY.badgesFor({ visit: { plan_id: "pl_0000000000000000000a", job_kind: "lights_install" }, job: null, property: { access: { gate_code: "1", pets: "Dog" } }, stats: { work: { jobs_completed: 0 } }, plan: { perks: ["unlimited touch-ups"] }, balance: 500 });
  assert.deepEqual(b.map((x) => x.key), ["plan", "balance", "gate", "pets", "first", "lights"]);
  assert.equal(b[0].label, "Plan member: unlimited touch-ups");
  assert.deepEqual(DAY.badgesFor({ visit: {}, job: null, property: null, stats: { work: { jobs_completed: 3 } } }), []);
});

test("Delano times on a phone anywhere (DST-safe), minutes as people read them, the drive time", () => {
  assert.equal(kit.isoFromLocal("2026-11-17", "09:00"), "2026-11-17T15:00:00.000Z");
  assert.equal(kit.isoFromLocal("2026-07-04", "09:00"), "2026-07-04T14:00:00.000Z");
  assert.equal(kit.isoFromLocal("2026-03-08", "03:30"), "2026-03-08T08:30:00.000Z", "spring forward");
  assert.equal(kit.isoFromLocal("2026-11-01", "01:30"), "2026-11-01T06:30:00.000Z", "fall back: the first 1:30");
  assert.equal(kit.hhmmOf("2026-11-17T15:00:00.000Z"), "09:00");
  assert.equal(kit.dowOf("2026-11-22T05:30:00.000Z"), "Sat", "late Saturday evening in Delano");
  assert.equal(kit.hm(192), "3 h 12 m");
  assert.equal(kit.hm(45), "45 min");
  assert.equal(kit.shortName({ display_name: "Pat Sample" }), "Pat S.");
  assert.equal(kit.etaMinutes(null, [45, -93]), 15, "no location: a quarter hour");
  assert.equal(kit.etaMinutes([45.0419, -93.7886], [45.0419, -93.7886]), 5);
  const far = kit.etaMinutes([45.0419, -93.7886], [44.8494, -93.7869]);
  assert.ok(far >= 25 && far <= 35, `Delano to Waconia: ${far} min`);
});
