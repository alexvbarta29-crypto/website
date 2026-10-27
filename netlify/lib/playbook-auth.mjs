// Sign-in for /playbook: the same office password and cookie as /office and
// /lights (see lights-auth.mjs), so one sign-in opens every office tool.

export { derive, sha256, same, ONE_YEAR, COOKIE, expected, readCookie, signedIn, cookieFor, toOffice } from "./lights-auth.mjs";
