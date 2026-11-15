// Pieces the Expenses screens share: the stylesheet and the categories'
// words. No data here (design §2.3).

let styled = false;
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/expenses/expenses.css";
  document.head.appendChild(l);
}

export const CATS = [["supplies", "Supplies"], ["fuel", "Fuel"], ["vehicle", "Vehicle"], ["equipment", "Equipment"], ["marketing", "Marketing"], ["subcontractor", "Subcontractor"], ["other", "Other"]];
export const catLabel = (k) => (CATS.find(([x]) => x === k) || [k, "Other"])[1];
export const localToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
