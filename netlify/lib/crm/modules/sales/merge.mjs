// Sales module: its part of a contact merge (design §5.1 merge, §11.3
// onMerge). Called once inside the merge op, before the merge moves the
// stragglers: b's deals, follow-ups and tasks move to the survivor a. A
// follow-up b has open in a cadence where a already has one open stops as a
// duplicate; otherwise it moves and a's one-open pointer names it.

import { updateRecord, claimOpenPointer, getRecord } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { OPEN_ENROLLMENT } from "./types.mjs";
import { setStatus, isOpen } from "./cadence.mjs";
import { relRecords, nameOf } from "./common.mjs";
import { enrollKey } from "./enroll.mjs";
import { now } from "../../core/clock.mjs";

const isOpenId = async (id) => {
  if (!isId(id, "enrollment")) return false;
  const g = await getRecord("enrollment", id);
  return !!(g && isOpen(g.data));
};

export async function onMergeSales(a, b, ctx = {}) {
  const survivor = await getRecord("contact", a);
  const name = survivor ? nameOf(survivor.data) : undefined;
  for (const e of await relRecords("contact-enrollments", "enrollment", b, { limit: 100 })) {
    if (OPEN_ENROLLMENT.includes(e.status)) {
      const claim = await claimOpenPointer("enroll", enrollKey(a, e.cadence_id), { id: e.id }, isOpenId);
      if (!claim.ok && claim.current && claim.current.id !== e.id) {
        await updateRecord("enrollment", e.id, (x) => {
          const stopped = setStatus(x, "stopped", { reason: "duplicate", now: now() }) || x;
          return { ...stopped, contact_id: a, ...(name ? { contact_name: name } : {}) };
        }, ctx);
        continue;
      }
    }
    await updateRecord("enrollment", e.id, (x) => (x.contact_id === b ? { ...x, contact_id: a, ...(name ? { contact_name: name } : {}) } : null), ctx);
  }
  for (const d of await relRecords("contact-deals", "deal", b, { limit: 100 })) {
    await updateRecord("deal", d.id, (x) => (x.contact_id === b ? { ...x, contact_id: a, ...(name ? { contact_name: name } : {}) } : null), ctx);
  }
  for (const t of await relRecords("contact-tasks", "task", b, { limit: 100 })) {
    await updateRecord("task", t.id, (x) => (x.contact_id === b ? { ...x, contact_id: a, ...(name ? { contact_name: name } : {}) } : null), ctx);
  }
}
