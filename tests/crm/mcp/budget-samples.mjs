// Budget samples for the mcp module's routes (read by
// tests/crm/core/budget.test.mjs): a batch of three MCP calls (the tool
// list, a contact search and an ask that becomes a pending action), a path
// key's contact read, the connector screen, the calendar feed's management
// and the feed itself (about five months of visit shards).
const { createApiKey } = await import("../../../netlify/lib/crm/core/apikeys.mjs");
const { issueFeed } = await import("../../../netlify/lib/crm/modules/mcp/calendar.mjs");

const READS = ["contacts:read", "contacts:read_all", "tasks:read", "quotes:read", "plans:read", "schedule:read", "invoices:read", "invoices:read_all", "inbox:read", "reports:read"];
const JSON_CT = { "content-type": "application/json" };

export default {
  "POST /mcp": async (fx) => {
    const { key } = await createApiKey(fx.owner.user, { name: "Budget MCP", scopes: [...READS, "messages:send"] });
    return {
      path: "/mcp", csrf: false, headers: { ...JSON_CT, authorization: `Bearer ${key}` },
      body: [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_contacts", arguments: { q: "Example" } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_message", arguments: { contact_id: fx.contact.id, body: "Running ten minutes late." } } },
      ],
    };
  },
  "POST /mcp/:key": async (fx) => {
    const { key } = await createApiKey(fx.owner.user, { name: "Budget link", kind: "path" });
    return { path: `/mcp/${key}`, csrf: false, headers: JSON_CT, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_contact", arguments: { contact_id: fx.contact.id } } } };
  },
  "GET /mcp/connect": (fx) => ({ as: fx.owner, path: "/mcp/connect" }),
  "GET /calendar-feed": (fx) => ({ as: fx.tech, path: "/calendar-feed" }),
  "POST /calendar-feed": (fx) => ({ as: fx.owner, path: "/calendar-feed", body: { scope: "all" } }),
  "PATCH /calendar-feed": (fx) => ({ as: fx.owner, path: "/calendar-feed", body: { scope: "mine" } }),
  "DELETE /calendar-feed": (fx) => ({ as: fx.owner, path: "/calendar-feed" }),
  "GET /cal/:token": async (fx) => {
    const { token } = await issueFeed(fx.admin.id, "all");
    return { path: `/cal/${token}.ics` };
  },
};
