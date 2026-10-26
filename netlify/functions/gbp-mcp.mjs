// Barta GBP — remote MCP connector for Google Business Profile
// Netlify Function. Add as a custom connector in claude.ai.
// File location in the repo: netlify/functions/gbp-mcp.mjs
//
// Required environment variables (Netlify → Site configuration → Environment variables;
// mark the first four "Contains secret values"):
//   GOOGLE_CLIENT_ID      ...apps.googleusercontent.com
//   GOOGLE_CLIENT_SECRET  GOCSPX-...
//   GOOGLE_REFRESH_TOKEN  1//...
//   MCP_SECRET            any long random string (part of the connector URL)
// Optional:
//   ACCOUNT_ID, LOCATION_ID  (auto-detected if you have exactly one location)
//
// Connector URL: https://<your-site>/mcp/<MCP_SECRET>

const V4 = "https://mybusiness.googleapis.com/v4";
const ACCT = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";
const PERF = "https://businessprofileperformance.googleapis.com/v1";

// ---------- Google auth + fetch ----------
let cachedToken = { token: null, exp: 0 };

async function accessToken(env) {
  if (cachedToken.token && Date.now() < cachedToken.exp - 60_000) return cachedToken.token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Google token refresh failed: " + JSON.stringify(j));
  cachedToken = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cachedToken.token;
}

async function g(env, method, url, body) {
  const t = await accessToken(env);
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  if (!r.ok) throw new Error(`Google API ${r.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

// ---------- Location helpers ----------
async function listAll(env) {
  const out = [];
  const { accounts = [] } = await g(env, "GET", `${ACCT}/accounts?pageSize=20`);
  for (const a of accounts) {
    const accountId = a.name.split("/")[1];
    let pageToken = "";
    do {
      const q = new URLSearchParams({ readMask: "name,title,storefrontAddress,websiteUri,phoneNumbers", pageSize: "100" });
      if (pageToken) q.set("pageToken", pageToken);
      const res = await g(env, "GET", `${INFO}/${a.name}/locations?${q}`);
      for (const l of res.locations || []) {
        out.push({
          account_id: accountId,
          account_name: a.accountName,
          location_id: l.name.split("/")[1],
          title: l.title,
          address: l.storefrontAddress?.addressLines?.join(", ") || null,
          website: l.websiteUri || null,
          phone: l.phoneNumbers?.primaryPhone || null,
        });
      }
      pageToken = res.nextPageToken || "";
    } while (pageToken);
  }
  return out;
}

let defaultLoc = null;
async function loc(env, a) {
  if (a.account_id && a.location_id) return { acct: String(a.account_id), loc: String(a.location_id) };
  if (env.ACCOUNT_ID && env.LOCATION_ID) return { acct: env.ACCOUNT_ID, loc: env.LOCATION_ID };
  if (defaultLoc) return defaultLoc;
  const all = await listAll(env);
  if (all.length !== 1) throw new Error(`Found ${all.length} locations. Pass account_id and location_id (see list_locations).`);
  defaultLoc = { acct: all[0].account_id, loc: all[0].location_id };
  return defaultLoc;
}

const v4Path = (l) => `${V4}/accounts/${l.acct}/locations/${l.loc}`;

function parseDate(s) {
  const [year, month, day] = String(s).split("-").map(Number);
  if (!year || !month || !day) throw new Error(`Bad date "${s}" — use YYYY-MM-DD`);
  return { year, month, day };
}

const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

// ---------- Tools ----------
const locArgs = {
  account_id: { type: "string", description: "Optional. Auto-detected if there is only one location." },
  location_id: { type: "string", description: "Optional. Auto-detected if there is only one location." },
};

const TOOLS = [
  {
    name: "list_locations",
    description: "List all Google Business Profile accounts and locations this login can manage.",
    inputSchema: { type: "object", properties: {} },
    run: async (_a, env) => listAll(env),
  },
  {
    name: "get_location",
    description: "Get the full business profile: name, categories, description, hours, special hours, service area, services, phone, website.",
    inputSchema: { type: "object", properties: { ...locArgs } },
    run: async (a, env) => {
      const l = await loc(env, a);
      const mask = "name,title,phoneNumbers,categories,storefrontAddress,websiteUri,regularHours,specialHours,serviceArea,profile,openInfo,metadata,serviceItems,labels";
      return g(env, "GET", `${INFO}/locations/${l.loc}?readMask=${mask}`);
    },
  },
  {
    name: "update_location",
    description:
      "Update business profile fields. Pass `fields` as a partial Location object and `update_mask` as a comma-separated list of the top-level fields being changed. " +
      'Examples: description → fields {"profile":{"description":"..."}}, update_mask "profile.description". ' +
      'Hours → fields {"regularHours":{"periods":[...]}}, update_mask "regularHours". Holiday hours → "specialHours". Website → "websiteUri".',
    inputSchema: {
      type: "object",
      properties: {
        ...locArgs,
        fields: { type: "object", description: "Partial Location object with the new values." },
        update_mask: { type: "string", description: "Comma-separated field paths being updated." },
      },
      required: ["fields", "update_mask"],
    },
    run: async (a, env) => {
      const l = await loc(env, a);
      return g(env, "PATCH", `${INFO}/locations/${l.loc}?updateMask=${encodeURIComponent(a.update_mask)}`, a.fields);
    },
  },
  {
    name: "list_reviews",
    description: "List Google reviews, newest first, with star rating, comment, and any existing reply. Also returns average rating and total count.",
    inputSchema: {
      type: "object",
      properties: {
        ...locArgs,
        page_size: { type: "number", description: "1-50, default 50" },
        page_token: { type: "string" },
        unreplied_only: { type: "boolean", description: "Only return reviews without a reply." },
      },
    },
    run: async (a, env) => {
      const l = await loc(env, a);
      const q = new URLSearchParams({ pageSize: String(a.page_size || 50), orderBy: "updateTime desc" });
      if (a.page_token) q.set("pageToken", a.page_token);
      const r = await g(env, "GET", `${v4Path(l)}/reviews?${q}`);
      let reviews = (r.reviews || []).map((x) => ({
        review_id: x.reviewId,
        reviewer: x.reviewer?.displayName,
        stars: STARS[x.starRating] ?? x.starRating,
        comment: x.comment || "",
        created: x.createTime,
        reply: x.reviewReply?.comment || null,
      }));
      if (a.unreplied_only) reviews = reviews.filter((x) => !x.reply);
      return { average_rating: r.averageRating, total_reviews: r.totalReviewCount, next_page_token: r.nextPageToken || null, reviews };
    },
  },
  {
    name: "reply_to_review",
    description: "Post or replace the owner reply on a review. Replies are public.",
    inputSchema: {
      type: "object",
      properties: { ...locArgs, review_id: { type: "string" }, comment: { type: "string", description: "Reply text (max 4096 chars)." } },
      required: ["review_id", "comment"],
    },
    run: async (a, env) => {
      const l = await loc(env, a);
      return g(env, "PUT", `${v4Path(l)}/reviews/${a.review_id}/reply`, { comment: a.comment });
    },
  },
  {
    name: "delete_review_reply",
    description: "Delete the owner reply on a review.",
    inputSchema: { type: "object", properties: { ...locArgs, review_id: { type: "string" } }, required: ["review_id"] },
    run: async (a, env) => {
      const l = await loc(env, a);
      await g(env, "DELETE", `${v4Path(l)}/reviews/${a.review_id}/reply`);
      return "Reply deleted.";
    },
  },
  {
    name: "list_posts",
    description: "List Google Business Profile posts (updates, events, offers).",
    inputSchema: { type: "object", properties: { ...locArgs, page_size: { type: "number" }, page_token: { type: "string" } } },
    run: async (a, env) => {
      const l = await loc(env, a);
      const q = new URLSearchParams({ pageSize: String(a.page_size || 20) });
      if (a.page_token) q.set("pageToken", a.page_token);
      const r = await g(env, "GET", `${v4Path(l)}/localPosts?${q}`);
      return {
        next_page_token: r.nextPageToken || null,
        posts: (r.localPosts || []).map((p) => ({
          name: p.name, type: p.topicType, state: p.state, summary: p.summary,
          created: p.createTime, url: p.searchUrl, cta: p.callToAction || null,
          event: p.event || null, offer: p.offer || null,
        })),
      };
    },
  },
  {
    name: "create_post",
    description:
      "Publish a Google Business Profile post. topic_type STANDARD (update), EVENT, or OFFER. EVENT and OFFER need event_title, start_date, end_date. " +
      "cta_type: BOOK, ORDER, SHOP, LEARN_MORE, SIGN_UP, CALL (CALL uses the profile phone, no URL). photo_url must be a public image URL (JPG/PNG).",
    inputSchema: {
      type: "object",
      properties: {
        ...locArgs,
        summary: { type: "string", description: "Post text, max 1500 chars." },
        topic_type: { type: "string", enum: ["STANDARD", "EVENT", "OFFER"] },
        cta_type: { type: "string", enum: ["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"] },
        cta_url: { type: "string" },
        photo_url: { type: "string" },
        event_title: { type: "string" },
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD" },
        offer_coupon: { type: "string" },
        offer_terms: { type: "string" },
        offer_url: { type: "string" },
      },
      required: ["summary"],
    },
    run: async (a, env) => {
      const l = await loc(env, a);
      const type = a.topic_type || "STANDARD";
      const body = { languageCode: "en-US", summary: a.summary, topicType: type };
      if (a.cta_type) {
        body.callToAction = { actionType: a.cta_type };
        if (a.cta_type !== "CALL") {
          if (!a.cta_url) throw new Error("cta_url is required for that button type.");
          body.callToAction.url = a.cta_url;
        }
      }
      if (a.photo_url) body.media = [{ mediaFormat: "PHOTO", sourceUrl: a.photo_url }];
      if (type === "EVENT" || type === "OFFER") {
        if (!a.event_title || !a.start_date || !a.end_date) throw new Error("EVENT/OFFER posts need event_title, start_date, end_date.");
        body.event = { title: a.event_title, schedule: { startDate: parseDate(a.start_date), endDate: parseDate(a.end_date) } };
      }
      if (type === "OFFER") {
        body.offer = {};
        if (a.offer_coupon) body.offer.couponCode = a.offer_coupon;
        if (a.offer_terms) body.offer.termsConditions = a.offer_terms;
        if (a.offer_url) body.offer.redeemOnlineUrl = a.offer_url;
      }
      return g(env, "POST", `${v4Path(l)}/localPosts`, body);
    },
  },
  {
    name: "delete_post",
    description: "Delete a post. Pass the full post `name` from list_posts.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    run: async (a, env) => {
      await g(env, "DELETE", `${V4}/${a.name}`);
      return "Post deleted.";
    },
  },
  {
    name: "add_photo",
    description: "Add a photo to the profile from a public image URL. category: EXTERIOR, INTERIOR, AT_WORK, TEAMS, PRODUCT, ADDITIONAL, COVER, PROFILE, LOGO.",
    inputSchema: {
      type: "object",
      properties: { ...locArgs, photo_url: { type: "string" }, category: { type: "string" }, description: { type: "string" } },
      required: ["photo_url"],
    },
    run: async (a, env) => {
      const l = await loc(env, a);
      const body = { mediaFormat: "PHOTO", sourceUrl: a.photo_url, locationAssociation: { category: a.category || "ADDITIONAL" } };
      if (a.description) body.description = a.description;
      return g(env, "POST", `${v4Path(l)}/media`, body);
    },
  },
  {
    name: "get_performance",
    description: "Profile performance totals for a date range: search and map views (mobile/desktop), calls, website clicks, direction requests. Includes daily values.",
    inputSchema: {
      type: "object",
      properties: { ...locArgs, start_date: { type: "string", description: "YYYY-MM-DD" }, end_date: { type: "string", description: "YYYY-MM-DD" } },
      required: ["start_date", "end_date"],
    },
    run: async (a, env) => {
      const l = await loc(env, a);
      const s = parseDate(a.start_date), e = parseDate(a.end_date);
      const metrics = [
        "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
        "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
        "CALL_CLICKS", "WEBSITE_CLICKS", "BUSINESS_DIRECTION_REQUESTS",
      ];
      const q = new URLSearchParams();
      metrics.forEach((m) => q.append("dailyMetrics", m));
      q.set("dailyRange.startDate.year", s.year); q.set("dailyRange.startDate.month", s.month); q.set("dailyRange.startDate.day", s.day);
      q.set("dailyRange.endDate.year", e.year); q.set("dailyRange.endDate.month", e.month); q.set("dailyRange.endDate.day", e.day);
      const r = await g(env, "GET", `${PERF}/locations/${l.loc}:fetchMultiDailyMetricsTimeSeries?${q}`);
      const totals = {}, daily = {};
      for (const group of r.multiDailyMetricTimeSeries || []) {
        for (const series of group.dailyMetricTimeSeries || []) {
          const m = series.dailyMetric;
          totals[m] = 0; daily[m] = [];
          for (const dv of series.timeSeries?.datedValues || []) {
            const v = Number(dv.value || 0);
            totals[m] += v;
            daily[m].push({ date: `${dv.date.year}-${String(dv.date.month).padStart(2, "0")}-${String(dv.date.day).padStart(2, "0")}`, value: v });
          }
        }
      }
      return { range: [a.start_date, a.end_date], totals, daily };
    },
  },
  {
    name: "get_search_keywords",
    description: "Monthly search terms people used to find the profile, with impression counts. Months as YYYY-MM.",
    inputSchema: {
      type: "object",
      properties: { ...locArgs, start_month: { type: "string", description: "YYYY-MM" }, end_month: { type: "string", description: "YYYY-MM" } },
      required: ["start_month", "end_month"],
    },
    run: async (a, env) => {
      const l = await loc(env, a);
      const [sy, sm] = a.start_month.split("-").map(Number);
      const [ey, em] = a.end_month.split("-").map(Number);
      const out = [];
      let pageToken = "";
      do {
        const q = new URLSearchParams({
          "monthlyRange.startMonth.year": sy, "monthlyRange.startMonth.month": sm,
          "monthlyRange.endMonth.year": ey, "monthlyRange.endMonth.month": em, pageSize: "100",
        });
        if (pageToken) q.set("pageToken", pageToken);
        const r = await g(env, "GET", `${PERF}/locations/${l.loc}/searchkeywords/impressions/monthly?${q}`);
        for (const k of r.searchKeywordsCounts || []) {
          out.push({ keyword: k.searchKeyword, impressions: k.insightsValue?.value ? Number(k.insightsValue.value) : `<${k.insightsValue?.threshold}` });
        }
        pageToken = r.nextPageToken || "";
      } while (pageToken && out.length < 500);
      return out;
    },
  },
];

// ---------- MCP (Streamable HTTP, JSON responses) ----------
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(m, env) {
  if (m.id === undefined || m.id === null) return null; // notification
  switch (m.method) {
    case "initialize":
      return ok(m.id, {
        protocolVersion: m.params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "barta-gbp", version: "1.0.0" },
        instructions: "Manages Barta Window Washing's Google Business Profile. Review replies and posts are public — confirm wording with the user before posting.",
      });
    case "ping":
      return ok(m.id, {});
    case "tools/list":
      return ok(m.id, { tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return err(m.id, -32602, `Unknown tool: ${m.params?.name}`);
      try {
        const r = await tool.run(m.params.arguments || {}, env);
        return ok(m.id, { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r, null, 2) }] });
      } catch (e) {
        return ok(m.id, { content: [{ type: "text", text: String(e?.message || e) }], isError: true });
      }
    }
    default:
      return err(m.id, -32601, `Method not found: ${m.method}`);
  }
}

export default async (req) => {
  const env = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN,
    MCP_SECRET: process.env.MCP_SECRET,
    ACCOUNT_ID: process.env.ACCOUNT_ID,
    LOCATION_ID: process.env.LOCATION_ID,
  };
  const url = new URL(req.url);
  if (!env.MCP_SECRET || url.pathname !== `/mcp/${env.MCP_SECRET}`) return new Response("Not found", { status: 404 });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });

  let msg;
  try { msg = await req.json(); } catch { return json(err(null, -32700, "Parse error"), 400); }

  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map((m) => handle(m, env)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const res = await handle(msg, env);
  return res ? json(res) : new Response(null, { status: 202 });
};

export const config = { path: "/mcp/*" };
