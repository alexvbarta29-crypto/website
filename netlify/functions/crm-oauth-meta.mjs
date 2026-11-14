// The OAuth discovery documents Claude reads before it connects to the
// CRM's MCP endpoint (docs/CRM-MCP.md, modules/mcp/oauth.mjs):
//   /.well-known/oauth-protected-resource[/api/crm/mcp]   RFC 9728: which server signs people in
//   /.well-known/oauth-authorization-server[/…]          RFC 8414: its endpoints, PKCE S256, scopes
// Static JSON from the deploy's origin (the canonical site in production);
// no storage, no cookies, open to any origin (CORS *).
import { deployContext, canonicalRedirect } from "../lib/crm/core/context.mjs";
import { authServerMetadata, resourceMetadata, issuerOf } from "../lib/crm/modules/mcp/oauth.mjs";

export const config = {
  path: ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/*", "/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/*"],
};

const HEADERS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "mcp-protocol-version, content-type", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex" };

export default async (req, context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { ...HEADERS, Allow: "GET, HEAD, OPTIONS" } });
  const deploy = deployContext(req, context);
  const moved = canonicalRedirect(req, deploy);
  if (moved) return moved;
  const url = new URL(req.url);
  const issuer = issuerOf({ deploy, url });
  const path = url.pathname.replace(/\/+$/, "");
  let body = null;
  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/api/crm/mcp") body = resourceMetadata(issuer);
  else if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/api/crm/mcp") body = authServerMetadata(issuer);
  if (!body) return Response.json({ error: "not_found" }, { status: 404, headers: HEADERS });
  return Response.json(body, { headers: HEADERS });
};
