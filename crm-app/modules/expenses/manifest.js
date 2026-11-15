// Client manifest of the "expenses" module (Flyra's Expenses; the Rotor guide's
// FE1, F15): Financials → Expenses, one expense, a new one (owners and the
// office), and Expense last in the + list. No data, keys or customer names
// ever go in crm-app/ (design §2.3).

export default {
  name: "expenses",
  routes: [
    { path: "/expenses", load: () => import("./expenses.js"), title: "Expenses", perm: "expenses:read", parent: "/today", skeleton: "list" },
    { path: "/expenses/new", load: () => import("./expense.js"), title: "New expense", perm: "expenses:write", parent: "/expenses" },
    { path: "/expenses/:id", load: () => import("./expense.js"), title: "Expense", perm: "expenses:read", parent: "/expenses" },
  ],
  nav: [],
  creates: [{ label: "Expense", path: "/expenses/new", perm: "expenses:write", order: 90, icon: "receipt", hint: "A receipt to keep" }],
  contactTabs: [],
  visitActions: [],
  todayCards: [],
  settings: [],
  styles: ["./expenses.css"],
};
