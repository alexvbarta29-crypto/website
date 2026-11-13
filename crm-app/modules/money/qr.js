// The pay QR's encoder moved to the shared helper (crm-app/core/qr.js), which
// the signs and flyers use too. Kept so a phone running an older copy of a
// money screen still finds it.
export * from "../../core/qr.js";
