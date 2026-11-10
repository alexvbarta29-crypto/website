// Barta CRM client: keeping a screen fresh (design §5.7.1 "Keeping screens
// fresh"). poll(path, everyMs, onData) reads a GET every everyMs while the
// app is on screen, with ETag/304 (an unchanged answer costs one tiny
// request and calls nothing), pauses while hidden, and refreshes at once
// on focus, visibilitychange and online. The badges poll /me/badges every
// 30 s; an open Thread (M6) polls every 10 s.
//
//   const p = poll("/me/badges", 30000, (data) => ...);   p.refresh(); p.stop();

import { api } from "./api.js";

export function poll(path, everyMs, onData, { immediate = true, onError } = {}) {
  let etag = null;
  let stopped = false;
  let busy = false;
  const hidden = () => typeof document !== "undefined" && document.hidden;
  async function tick(force = false) {
    if (stopped || busy || (!force && hidden())) return;
    busy = true;
    try {
      const r = await api(path, { cache: false, ifNoneMatch: etag || undefined });
      if (!r.notModified) {
        etag = r.etag || null;
        onData(r.data, r.meta);
      }
    } catch (e) {
      if (onError) onError(e);
    } finally {
      busy = false;
    }
  }
  const wake = () => { if (!hidden()) tick(); };
  const timer = setInterval(tick, Math.max(1000, everyMs));
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", wake);
  if (typeof window !== "undefined") { window.addEventListener("focus", wake); window.addEventListener("online", wake); }
  if (immediate) tick();
  return {
    refresh: () => tick(true),
    stop() {
      stopped = true;
      clearInterval(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", wake);
      if (typeof window !== "undefined") { window.removeEventListener("focus", wake); window.removeEventListener("online", wake); }
    },
  };
}
