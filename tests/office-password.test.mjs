// The office password can be committed sealed (build/office_password.mjs):
// only the key holder can open it, and lights-auth's check comes from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newKeyPair, open, privateKey } from "../netlify/lib/office-data.mjs";
import { derive, sha256 } from "../netlify/lib/lights-auth.mjs";
import { sealedPasswordFile } from "../build/office_password.mjs";

test("a sealed office password opens only with the office key and carries the PBKDF2 check", () => {
  const kp = newKeyPair();
  const text = sealedPasswordFile("example-office-pw", kp.publicKeyPem);
  assert.ok(!text.includes("example-office-pw"));
  assert.ok(!text.includes(sha256(derive("example-office-pw"))), "the check itself is not in the file");
  const box = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  const got = open(box, privateKey({ OFFICE_DATA_KEY: kp.privateKey }));
  assert.equal(got.check, sha256(derive("example-office-pw")));
  const other = newKeyPair();
  assert.throws(() => open(box, privateKey({ OFFICE_DATA_KEY: other.privateKey })));
  assert.throws(() => sealedPasswordFile("short", kp.publicKeyPem));
});
