// The Visit screen's one big button (the layout report, Nov 2026: "The
// visit page lives or dies on one big button"): which step it shows for the
// state the visit is in, On my way → Start → Finish → Get paid. Pure: no
// DOM, no I/O, so the tests walk every state (tests/crm/work-field/
// visit-step.test.mjs).
//
// It only ever names a transition work/states.mjs already has (on_my_way,
// start, finish; Get paid is Money's existing "Collect payment"), and it
// keeps the field panel's rules: On my way texts the customer, so it needs
// signal (design §2.5: never queued); with no signal the button offers
// Start instead, which works offline like the rest. Finish waits for the
// required checklist items (the button says so, it isn't hidden). Get paid
// shows only when this person may collect and something is owed.
//
//   nextStep({ status, missing, online, collect }) → { key, label, attr, note?, blocked? } | null
//     status   the visit's status as this phone shows it (waiting changes laid over it)
//     missing  the labels of required checklist items not done yet
//     online   the phone has signal
//     collect  { key, owed } from Money's visitAction (owed: true when there is something to collect), or null

export const STEPS = Object.freeze({
  omw: { key: "omw", label: "On my way", attr: { "data-omw": true } },
  start: { key: "start", label: "Start", attr: { "data-timer": "start" } },
  resume: { key: "resume", label: "Resume", attr: { "data-timer": "start" } },
  finish: { key: "finish", label: "Finish", attr: { "data-complete": true } },
  pay: { key: "pay", label: "Get paid", attr: {} },
});

export function nextStep({ status, missing = [], online = true, collect = null } = {}) {
  const step = (k, extra = {}) => ({ ...STEPS[k], attr: { ...STEPS[k].attr }, ...extra });
  switch (status) {
    case "scheduled":
      // On my way texts the customer: with no signal, the next thing that works is Start
      return online ? step("omw") : step("start", { note: "No signal: On my way texts the customer, so it waits. Start works now." });
    case "en_route":
      return step("start");
    case "in_progress":
      return step("finish", missing.length ? { blocked: missing } : {});
    case "paused":
      // a break: back to work first (Finish stays one tap away in the card)
      return step("resume");
    case "completed":
      return collect && collect.key && collect.owed ? step("pay", { attr: { "data-vact": collect.key } }) : null;
    default:
      return null;     // no access, cancelled: nothing left to do here
  }
}

// What Money's "Collect payment" answer (GET /visits/:id/payment) says is owed.
export const owedFrom = (p) => !!(p && p.can && (p.can.record || p.can.link || p.can.make));
