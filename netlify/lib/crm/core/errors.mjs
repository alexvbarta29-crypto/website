// Barta CRM core: every error class the CRM throws, and how each one maps to
// an HTTP answer (design §2.2 step 10, §3.14). One file so the dispatcher
// (core/router.mjs, M1.2), the store (netlify/lib/crm-store.mjs, which
// re-exports the storage errors) and every module agree on the classes.
//
// Messages are plain English aimed at the office. They never carry a name,
// phone, email, address or amount tied to a person: errors end up in logs
// (through safeErr) and in API error bodies.

class CrmError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = new.target.name;
    Object.assign(this, extra);
  }
}

// 400 invalid (+ field): bad input, caught by a validator.
export class InputError extends CrmError {
  constructor(message = "That doesn't look right.", field = undefined, extra = {}) {
    super(message, { field, ...extra });
  }
}
// 403 forbidden.
export class ForbiddenError extends CrmError {}
// 404 not found.
export class NotFoundError extends CrmError {}
// 409 conflict (a business rule, not a storage race).
export class ConflictError extends CrmError {}
// 409 exists: a create found the key already taken by someone else.
export class ExistsError extends CrmError {}
// 412 stale: the record changed since the client read it.
export class StaleError extends CrmError {
  constructor(current = null, etag = null, message = "Someone else just changed this.") {
    super(message, { current, etag });
  }
}
// 503 busy: Blobs kept failing (after the store's own retries).
export class BlobsTransientError extends CrmError {}
// 503 busy, maybe_saved: a write may or may not have landed; a fix/ marker
// names it for the worker's fix.settle step (fixKey may be null when even
// that marker could not be written).
export class UnknownOutcome extends CrmError {
  constructor(fixKey = null, message = "Storage didn't answer. Try again in a minute.") {
    super(message, { fixKey });
  }
}
// 409 parallel_run: automation tried to change a record Rotor still owns (§3.10).
export class ParallelRunGuard extends CrmError {
  constructor(message = "Rotor is still in charge of this record.", extra = {}) {
    super(message, extra);
  }
}
// The stored record was written by newer code (schema rules, §3.14).
export class SchemaTooNew extends CrmError {}
// openStore() refused a production store name outside production (§3.10).
export class ProdStoreRefused extends CrmError {}
// openStore() was called without the branded deploy object (§3.10).
export class DeployContextRequired extends CrmError {}
// A production deploy without the Production-only settings (CRM_PRODUCTION):
// a ProdStoreRefused the shell turns into a "Setup needed" screen.
export class SetupNeeded extends ProdStoreRefused {}
// A request went over its time or Blobs-call budget (§2.2, §3.13).
export class BudgetError extends CrmError {}
// A storage attempt or an external call ran out of time.
export class TimeoutError extends CrmError {}
// core/services.mjs: a needed service is not provided (yet).
export class ServiceMissing extends CrmError {}
// core/registry.mjs: a module manifest or type definition is invalid.
export class RegistryError extends CrmError {}

const BUSY = "Storage didn't answer. Try again in a minute.";

// What an error becomes on the wire: { status, code, message, field?, details? }.
// Unknown errors are 500 "failed"; the caller logs them with safeErr.
export function errorResponse(e) {
  if (e instanceof InputError) return { status: 400, code: "invalid", message: e.message, field: e.field };
  if (e instanceof ForbiddenError) return { status: 403, code: "forbidden", message: e.message || "You don't have access to that." };
  if (e instanceof NotFoundError) return { status: 404, code: "not_found", message: e.message || "Not found." };
  if (e instanceof StaleError) return { status: 412, code: "stale", message: e.message, details: { current: e.current, etag: e.etag } };
  if (e instanceof ExistsError) return { status: 409, code: "exists", message: e.message || "That already exists." };
  if (e instanceof ParallelRunGuard) return { status: 409, code: "parallel_run", message: e.message };
  if (e instanceof ConflictError) return { status: 409, code: "conflict", message: e.message };
  if (e instanceof ProdStoreRefused) return { status: 503, code: "setup_needed", message: "The CRM needs its setup in Netlify first." };
  if (e instanceof UnknownOutcome) return { status: 503, code: "busy", message: BUSY, details: { maybe_saved: true } };
  if (e instanceof TimeoutError || e instanceof BlobsTransientError || e instanceof BudgetError) return { status: 503, code: "busy", message: BUSY };
  return { status: 500, code: "failed", message: "Something went wrong. Try again." };
}
