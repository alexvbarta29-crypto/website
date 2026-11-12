// Client manifest of the "comms" module (M6, design §11.3, §9.2): the Inbox
// (a list beside its thread on a wide screen), a thread with its composer,
// the contact's Messages tab, Campaigns and the campaign builder, Reviews,
// and Settings → Texting, email & reviews. Screens load with dynamic
// import(). No data, keys or customer names ever go in crm-app/ (§2.3).

export default {
  name: "comms",
  routes: [
    { path: "/inbox", load: () => import("./inbox.js"), title: "Inbox", perm: "inbox:read", skeleton: "list", split: true },
    { path: "/inbox/new", load: () => import("./compose.js"), title: "Text someone", perm: "contacts:read_all", parent: "/inbox" },
    { path: "/inbox/:id", load: () => import("./thread.js"), title: "Conversation", perm: "inbox:read", parent: "/inbox" },
    { path: "/campaigns", load: () => import("./campaigns.js"), title: "Campaigns", perm: "campaigns:write", parent: "/menu", skeleton: "list" },
    { path: "/campaigns/:id", load: () => import("./campaign.js"), title: "Campaign", perm: "campaigns:write", parent: "/campaigns" },
    { path: "/reviews", load: () => import("./reviews.js"), title: "Reviews", perm: "reviews:match", parent: "/menu", skeleton: "list" },
    { path: "/settings/texting", load: () => import("./setup.js"), title: "Texting, email & reviews", perm: "settings:messaging", parent: "/settings" },
  ],
  nav: [
    { where: "more", section: "messages", label: "Campaigns", path: "/campaigns", perm: "campaigns:write", order: 20, icon: "send" },
    { where: "more", section: "messages", label: "Reviews", path: "/reviews", perm: "reviews:match", order: 30, icon: "check" },
  ],
  creates: [{ label: "Text someone", path: "/inbox/new", perm: "contacts:read_all", order: 50, icon: "text" }],
  contactTabs: [{ key: "messages", label: "Messages", order: 70, place: "aside", perm: "inbox:read", load: () => import("./contact-tab.js") }],
  visitActions: [],
  todayCards: [],
  settings: [{ label: "Texting, email & reviews", path: "/settings/texting", perm: "settings:messaging", icon: "text", order: 47 }],
  styles: ["./comms.css"],
};
