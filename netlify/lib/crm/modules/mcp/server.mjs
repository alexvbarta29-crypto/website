// MCP module (M7c): the CRM's remote MCP endpoint (design §6.9, §4.9).
//
//   POST /api/crm/mcp          Authorization: Bearer bcrm_…  (a header key)
//   POST /api/crm/mcp/:key     the key in the path (a "path" key: read-only,
//                              30 calls a minute; for claude.ai connectors,
//                              which cannot send a header)
//   GET  /api/crm/mcp/connect  (signed in) what the connector screen shows
//
// JSON-RPC 2.0 over Streamable HTTP with plain JSON answers, like
// netlify/functions/gbp-mcp.mjs: initialize, notifications/initialized,
// ping, tools/list, tools/call (a batch of up to MAX_BATCH). GET and DELETE
// answer 405 (no server-sent stream). Both routes check their own key
// (auth "hook"): the key acts as its user with role ∩ scopes; a disabled
// user's keys stop working; a backup key is refused; a path key only ever
// works in the path, never a header key (a header key there would end up
// in someone's logs).
//
// Tools: every module's manifest mcpTools plus this module's own
// (tools.mjs). tools/list shows the ones this key may use. A read runs
// with the key's user and scopes. Anything else (effect write, contact or
// money) becomes a pending action an owner approves (actions.mjs); a path
// key can't ask. Every result passes through wrapUntrusted().

import { lookupApiKey, checkKeyRate, touchApiKey } from "../../core/apikeys.mjs";
import { authenticate, loadPermissions } from "../../core/auth.mjs";
import { getRecord } from "../../../crm-store.mjs";
import { allModules } from "../../core/registry.mjs";
import { errorResponse, RateLimited, BudgetError, InputError } from "../../core/errors.mjs";
import { CANONICAL_ORIGIN } from "../../core/context.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { keyMay } from "./invoke.mjs";
import { requestAction, registerExecutor, issueConfirmToken, useConfirmToken } from "./actions.mjs";
import { wrapUntrusted, UNTRUSTED_NOTE } from "./untrusted.mjs";
import { tools as ownTools } from "./tools.mjs";

export const PROTOCOL = "2025-03-26";
export const SUPPORTED_PROTOCOLS = Object.freeze(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
export const MAX_BATCH = 5;
export const MAX_BODY = 64 * 1024;
export const SERVER_INFO = Object.freeze({ name: "barta-crm", title: "Barta CRM", version: "1.0.0" });
export const INSTRUCTIONS = [
  "Barta Window Washing's CRM: customers, leads, quotes, plans, the schedule, invoices, payments, messages and reports. Money is in cents; dates are Central time (America/Chicago).",
  "Reads answer at once. Anything that changes something (a text, a task, a quote, a job, a deal move) is only a REQUEST: it waits for an owner's approval in the CRM (Approvals) and nothing happens before that. Say so to the person; check later with get_pending_action.",
  UNTRUSTED_NOTE,
  "Rotor is still the system of record until the switch-over; texts and emails stay in dry-run until the owner switches them on.",
].join(" ");

const EFFECTS = new Set(["read", "write", "contact", "money"]);

// ------------------------------------------------------------ the catalog

let catalog = null;
// Every tool, once: { ...tool, module }. A module tool without an `exec`
// runs its own run() when approved.
export function allTools() {
  if (catalog) return catalog;
  const out = new Map();
  const add = (t, module) => {
    if (!t || typeof t.name !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(t.name)) throw new Error(`mcp: bad tool name in ${module}`);
    if (out.has(t.name)) throw new Error(`mcp: tool ${t.name} is declared twice`);
    if (!EFFECTS.has(t.effect)) throw new Error(`mcp: tool ${t.name} needs an effect`);
    if (t.perm !== null && !(typeof t.perm === "string" && /^[a-z_]+:[a-z_]+$/.test(t.perm))) throw new Error(`mcp: tool ${t.name} needs a perm`);
    const tool = { ...t, module, exec: t.exec || (t.effect !== "read" ? (args, ctx) => t.run(args, ctx) : undefined) };
    if (tool.effect !== "read" && typeof tool.exec !== "function") throw new Error(`mcp: tool ${t.name} changes something but has nothing to run`);
    if (tool.effect === "read" && typeof tool.run !== "function") throw new Error(`mcp: tool ${t.name} has no run()`);
    out.set(t.name, tool);
    if (tool.effect !== "read") registerExecutor(tool);
  };
  for (const t of ownTools) add(t, "mcp");
  for (const m of allModules()) if (m.name !== "mcp") for (const t of m.mcpTools || []) add(t, m.name);
  catalog = [...out.values()];
  return catalog;
}
export const toolNamed = (name) => allTools().find((t) => t.name === name) || null;

// May this key use the tool at all? (a path key: reads only)
export function toolAllowed(ctx, tool) {
  if (tool.perm === null) return true;
  if (ctx.apiKey && ctx.apiKey.kind === "path" && tool.effect !== "read") return false;
  return keyMay(ctx, tool.perm, { scoped: !!tool.scoped });
}

const describe = (t) => ({
  name: t.name,
  title: t.title || t.name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
  description: `${t.description}${t.effect === "read" ? "" : " This only asks: it waits for an owner's approval in the CRM."} ${UNTRUSTED_NOTE}`,
  inputSchema: t.inputSchema || { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: t.effect === "read", destructiveHint: t.effect !== "read" && !!t.confirm, idempotentHint: t.effect === "read", openWorldHint: t.effect === "contact" || t.effect === "money" },
});

// ------------------------------------------------------------ argument checks

// A small JSON-schema check (the shapes the tools use): object, required,
// additionalProperties false, string / integer / number / boolean / array
// types and enums, one level deep.
export function checkArgs(schema, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) throw new InputError("Arguments must be an object.");
  const props = (schema && schema.properties) || {};
  for (const r of (schema && schema.required) || []) if (args[r] === undefined || args[r] === null || args[r] === "") throw new InputError(`${r} is required.`, r);
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) { if (schema && schema.additionalProperties === false) throw new InputError(`Unknown argument ${k}.`, k); continue; }
    if (v === undefined || v === null) continue;
    const bad = (p.type === "string" && typeof v !== "string") || (p.type === "integer" && !Number.isSafeInteger(v)) || (p.type === "number" && !Number.isFinite(v))
      || (p.type === "boolean" && typeof v !== "boolean") || (p.type === "array" && !Array.isArray(v)) || (p.type === "object" && (typeof v !== "object" || Array.isArray(v)));
    if (bad) throw new InputError(`${k} should be ${p.type === "integer" ? "a whole number" : `a ${p.type}`}.`, k);
    if (p.enum && !p.enum.includes(v)) throw new InputError(`${k} must be one of ${p.enum.join(", ")}.`, k);
    if (typeof v === "string" && v.length > 4000) throw new InputError(`${k} is too long.`, k);
    if (Array.isArray(v) && v.length > 100) throw new InputError(`${k} has too many items.`, k);
  }
  return args;
}

// ------------------------------------------------------------ tools/call

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });
const toolError = (message) => ({ ...text(message), isError: true });

export async function callTool(ctx, name, rawArgs) {
  const tool = toolNamed(name);
  if (!tool || !toolAllowed(ctx, tool)) {
    if (tool && ctx.apiKey && ctx.apiKey.kind === "path" && tool.effect !== "read") return toolError("This connector link is read-only. To let Claude ask for approvals (texts, tasks, quotes), connect with a header key (see Settings → Claude connector).");
    return toolError(tool ? "This key doesn't have access to that tool." : `There's no tool called ${String(name).slice(0, 60)}.`);
  }
  try {
    const args = checkArgs(tool.inputSchema, rawArgs);
    if (tool.effect === "read") return text(wrapUntrusted(await tool.run(args, ctx)));
    // a change: preview, then (for a confirm tool) the token, then the owner's approval
    const { confirm_token: token, ...rest } = args;
    const preview = tool.preview ? await tool.preview(rest, ctx) : { title: describe(tool).title, rendered_text: Object.entries(rest).map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n").slice(0, 1500) };
    if (tool.confirm) {
      if (!token) {
        const t = await issueConfirmToken(tool, rest, ctx);
        return text(wrapUntrusted({ status: "needs_confirmation", preview: { title: preview.title, details: preview.rendered_text }, confirm_token: t.token, expires_at: t.expires_at,
          message: "Nothing has changed. If this is right, call the tool again with exactly the same arguments plus this confirm_token; that sends it to an owner for approval." }));
      }
      await useConfirmToken(token, tool, rest, ctx);
    }
    return text(await requestAction(tool, rest, preview, ctx));
  } catch (e) {
    if (e instanceof BudgetError) throw e;                    // the request's budget: a 503, never hidden
    const er = errorResponse(e);
    if (er.code === "failed") console.error(`crm:mcp: tool ${tool.name} failed (${safeErr(e)})`);
    return toolError(er.message);
  }
}

// ------------------------------------------------------------ JSON-RPC

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function handleMessage(ctx, m) {
  if (!m || typeof m !== "object" || Array.isArray(m) || m.jsonrpc !== "2.0" || typeof m.method !== "string") return rpcError(m && m.id, -32600, "Invalid request");
  if (m.id === undefined || m.id === null) return null;                // a notification (notifications/initialized, cancelled): nothing to answer
  const p = m.params && typeof m.params === "object" ? m.params : {};
  switch (m.method) {
    case "initialize": {
      const asked = typeof p.protocolVersion === "string" ? p.protocolVersion : PROTOCOL;
      return ok(m.id, { protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case "ping": return ok(m.id, {});
    case "tools/list": return ok(m.id, { tools: allTools().filter((t) => toolAllowed(ctx, t)).map(describe) });
    case "tools/call": {
      if (typeof p.name !== "string") return rpcError(m.id, -32602, "Name the tool.");
      return ok(m.id, await callTool(ctx, p.name, p.arguments));
    }
    case "resources/list": return ok(m.id, { resources: [] });
    case "prompts/list": return ok(m.id, { prompts: [] });
    default: return rpcError(m.id, -32601, `Method not found: ${String(m.method).slice(0, 60)}`);
  }
}

const rpcJson = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...(body === null ? {} : { "Content-Type": "application/json" }), ...headers } });
const unauthorized = (msg = "Unauthorized") => rpcJson(rpcError(null, -32001, msg), 401, { "WWW-Authenticate": 'Bearer realm="barta-crm"' });

// The key, as authenticate() finds it for a header; a path key by hand.
async function keyFromPath(raw) {
  const key = await lookupApiKey(raw);
  if (!key || key.kind !== "path") return null;
  const rec = await getRecord("user", key.user_id);
  const user = rec && rec.data;
  if (!user || user.status !== "active") return null;
  await checkKeyRate(key);
  touchApiKey(key).catch(() => {});
  return { user, apiKey: key };
}

async function serve(ctx, who) {
  if (!who || !who.user || !who.apiKey || who.apiKey.kind === "backup") return unauthorized("That key doesn't work here. Make one in the CRM: Settings → Claude connector.");
  Object.assign(ctx, { user: who.user, apiKey: who.apiKey });
  try { ctx.permissions = await loadPermissions(); } catch (e) {
    console.error(`crm:mcp: permissions not read (${safeErr(e)})`);
    return rpcJson(rpcError(null, -32002, "Storage didn't answer. Try again in a minute."), 503, { "Retry-After": "5" });
  }
  let msg;
  try { msg = JSON.parse(Buffer.from(ctx.raw || []).toString("utf8")); } catch { return rpcJson(rpcError(null, -32700, "Parse error"), 400); }
  if (Array.isArray(msg)) {
    if (!msg.length || msg.length > MAX_BATCH) return rpcJson(rpcError(null, -32600, `Send 1 to ${MAX_BATCH} messages at a time.`), 400);
    const out = [];
    for (const m of msg) { const r = await handleMessage(ctx, m); if (r) out.push(r); }
    return out.length ? rpcJson(out) : rpcJson(null, 202);
  }
  const r = await handleMessage(ctx, msg);
  if (r && r.error && r.error.code === -32600) return rpcJson(r, 400);
  return r ? rpcJson(r) : rpcJson(null, 202);
}

async function headerRoute(ctx) {
  let who;
  try { who = await authenticate(ctx.req, "key"); } catch (e) {
    if (e instanceof RateLimited) return rpcJson(rpcError(null, -32029, e.message), 429, { "Retry-After": String(e.retryAfterS || 60) });
    throw e;
  }
  if (who && who.apiKey && who.apiKey.kind === "path") who = null;   // a path key belongs in the path (and stays read-only there)
  return serve(ctx, who);
}
async function pathRoute(ctx) {
  let who;
  try { who = await keyFromPath(ctx.params.key); } catch (e) {
    if (e instanceof RateLimited) return rpcJson(rpcError(null, -32029, e.message), 429, { "Retry-After": String(e.retryAfterS || 60) });
    throw e;
  }
  return serve(ctx, who);
}

// GET /mcp/connect: the connector screen (Settings → Claude connector).
async function connectInfo(ctx) {
  const list = allTools();
  const byEffect = (pred) => list.filter(pred).map((t) => t.name).sort();
  return {
    data: {
      url: `${CANONICAL_ORIGIN}/api/crm/mcp`, path_url_template: `${CANONICAL_ORIGIN}/api/crm/mcp/{key}`, protocol: PROTOCOL,
      tools: { read: byEffect((t) => t.effect === "read"), ask: byEffect((t) => t.effect !== "read") },
      // the scopes the "ask for approvals" preset ticks: what the asking tools need and this person holds
      ask_scopes: [...new Set(list.filter((t) => t.effect !== "read" && t.perm && ctx.holds(t.perm) === true).map((t) => t.perm))].sort(),
    },
  };
}

const R = (method, path, handler, more = {}) => ({ method, path, auth: "hook", perm: null, subject: "none", mode: "inline", handler, body: "raw", maxBody: MAX_BODY, idempotent: false, maxCalls: 250, ...more });
export const mcpRoutes = [
  R("POST", "/mcp", headerRoute),
  R("POST", "/mcp/:key", pathRoute),
  { method: "GET", path: "/mcp/connect", auth: "session", perm: "api_keys:own", subject: "none", mode: "inline", handler: connectInfo },
];

// tests
export function __resetCatalogForTests() { catalog = null; }
