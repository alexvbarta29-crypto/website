// Test helper: the CRM's one clock, pinned (design §12.6). Tests never read
// the real date: pin() before acting, advance() to move time, unpin() after.
import { setNow, now, nowMs } from "../../netlify/lib/crm/core/clock.mjs";

export function pin(at = "2026-11-17T15:00:00Z") { setNow(at); return now(); }
export function advance(ms) { setNow(nowMs() + ms); return now(); }
export const minutes = (n) => n * 60 * 1000;
export const hours = (n) => n * 3600 * 1000;
export const days = (n) => n * 86400 * 1000;
export function unpin() { setNow(null); }
export { now, nowMs };
