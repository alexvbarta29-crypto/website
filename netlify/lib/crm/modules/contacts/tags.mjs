// Contacts: tags and the owner, for the automation builder
// (modules/automations) and the "a tag is added" trigger.
//
// - contact.tagged { contact_id, tags: [added] }: after a person's edit adds
//   tags (PATCH /contacts/:id) or a service call does. The event id comes
//   from the contact's write counter under its own name ("tags:{id}"), so it
//   never shares an id with another event of the same write.
// - contacts.tag(contact_id, { add?, remove? }, ctx) → { changed, tags }
// - contacts.setOwner(contact_id, user_id, ctx) → { changed }
// Both write through the store, so its parallel-run backstop guards an
// automation's write to a contact Rotor still owns (tags and owner_id are
// Rotor's fields); the builder asks the guard first and reports instead.

import { getRecord, updateRecord } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { NotFoundError, ConflictError } from "../../core/errors.mjs";
import { emit } from "../../core/events.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { cleanTags, MAX_TAGS } from "./types.mjs";

const W = (ctx = {}) => (typeof ctx.write === "function" ? ctx.write() : ctx);
const low = (s) => String(s).toLowerCase();

// The tags in `after` that `before` didn't have (case aside).
export const addedTags = (before = [], after = []) => after.filter((t) => !before.some((b) => low(b) === low(t)));

export async function emitTagged(before, after, ctx = {}) {
  const added = addedTags(before.tags || [], after.tags || []);
  if (!added.length) return null;
  return emit("contact.tagged", { id: `tags:${after.id}`, wv: after.wv, contact_id: after.id, tags: added }, W(ctx))
    .catch((e) => console.error(`crm:contacts: contact.tagged not queued (${safeErr(e)})`));
}

async function writable(id) {
  if (!isId(id, "contact")) throw new NotFoundError("That contact isn't there.");
  const got = await getRecord("contact", id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That contact isn't there.");
  if (got.data.merged_into || got.data.merging_into) throw new ConflictError("This contact was merged into another one.");
  return got;
}

export async function tagContact(contactId, { add = [], remove = [] } = {}, ctx = {}) {
  const before = (await writable(contactId)).data;
  const r = await updateRecord("contact", contactId, (c) => {
    let tags = (c.tags || []).filter((t) => !remove.some((x) => low(x) === low(t)));
    for (const t of add) if (!tags.some((x) => low(x) === low(t)) && tags.length < MAX_TAGS) tags.push(t);
    tags = cleanTags(tags, "tags");
    return JSON.stringify(tags) === JSON.stringify(c.tags || []) ? null : { ...c, tags };
  }, W(ctx));
  if (r.changed) await emitTagged(before, r.data, ctx);
  return { changed: !!r.changed, tags: r.data.tags || [] };
}

export async function setOwner(contactId, userId, ctx = {}) {
  if (!isId(userId, "user")) throw new NotFoundError("That person isn't on the team.");
  await writable(contactId);
  const r = await updateRecord("contact", contactId, (c) => (c.owner_id === userId ? null : { ...c, owner_id: userId }), W(ctx));
  return { changed: !!r.changed };
}
