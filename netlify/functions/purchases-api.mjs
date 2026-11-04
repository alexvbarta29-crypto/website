// GET/POST /api/purchases — the Barta Office purchase list (see
// netlify/lib/purchases.mjs). Signed-in office browsers only.

import { signedIn } from "../lib/lights-auth.mjs";
import { openStore, allItems, getItem, saveItem, newItem, applyAction, InputError, PEOPLE, DECIDER } from "../lib/purchases.mjs";

export const config = { path: "/api/purchases" };

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });

export default async (req) => {
  if (!signedIn(req)) return json({ ok: false, error: "signed_out" }, 401);
  let store;
  try { store = await openStore(); } catch (e) { return json({ ok: false, error: "Storage is unavailable right now. Try again in a minute." }, 503); }
  try {
    if (req.method === "GET") return json({ ok: true, people: PEOPLE, decider: DECIDER, items: await allItems(store) });
    if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: "Bad request." }, 400); }
    if (!body || typeof body !== "object") return json({ ok: false, error: "Bad request." }, 400);
    if (body.action === "create") {
      const it = newItem(body);
      await saveItem(store, it);
      return json({ ok: true, item: it });
    }
    const id = String(body.id || "");
    if (!/^[0-9a-f-]{6,40}$/.test(id)) return json({ ok: false, error: "Bad request." }, 400);
    const it = await getItem(store, id);
    if (!it) return json({ ok: false, error: "That item was deleted." }, 404);
    if (body.action === "delete") {
      await store.delete(`item/${id}`);
      return json({ ok: true, deleted: id });
    }
    const updated = applyAction(it, body);
    await saveItem(store, updated);
    return json({ ok: true, item: updated });
  } catch (e) {
    if (e instanceof InputError) return json({ ok: false, error: e.message }, 400);
    console.error("purchases:", e && e.message);
    return json({ ok: false, error: "Something went wrong. Try again." }, 500);
  }
};
