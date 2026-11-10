// The job and visit state machines (design §5.5), including the field
// transitions M4b uses. Owned by M4a and frozen at the start of wave 3
// (§11.1 rule 9). Stub until M4a: the tables are empty, so every
// (state, event) pair is refused with InputError("transition"), which is
// exactly how a pair missing from a filled table must behave (§12.2).

import { InputError } from "../../core/errors.mjs";

export const JOB_STATES = Object.freeze({});
export const VISIT_STATES = Object.freeze({});

// table: { [state]: { [event]: nextState } } → the next state, or InputError("transition").
export function transition(table, state, event) {
  const next = table[state] && table[state][event];
  if (!next) throw new InputError("That step isn't possible from here.", "transition");
  return next;
}
