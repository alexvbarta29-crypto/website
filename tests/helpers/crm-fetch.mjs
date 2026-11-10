// Test helper: a strict fetch (design §12.6). Tests declare the outside
// services they expect (Stripe, Twilio, Postmark, Google...) as routes;
// any other request is refused, recorded, and fails the test at restore()
// time. Nothing in a test ever reaches the network.
//
//   const net = strictFetch([{ match: /api\.stripe\.com/, respond: (url, init) => Response.json({...}) }]);
//   ...; net.calls; net.restore();   // throws if an undeclared request was made

export function strictFetch(routes = []) {
  const saved = globalThis.fetch;
  const calls = [];
  const refused = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method || (input && input.method) || "GET").toUpperCase();
    calls.push({ url, method });
    const r = routes.find((x) => (x.match instanceof RegExp ? x.match.test(url) : String(url).includes(x.match)));
    if (!r) {
      refused.push({ url, method });
      throw new TypeError(`strictFetch: undeclared request ${method} ${new URL(url).host}`);
    }
    return r.respond(url, init);
  };
  return {
    calls,
    refused,
    restore({ allowRefused = false } = {}) {
      globalThis.fetch = saved;
      if (refused.length && !allowRefused) throw new Error(`strictFetch: ${refused.length} undeclared request(s): ${refused.map((r) => r.method + " " + new URL(r.url).host).join(", ")}`);
    },
  };
}
