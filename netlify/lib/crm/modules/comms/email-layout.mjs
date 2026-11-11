// Comms: the one branded email layout (design §5.7.1 "Email").
//
// White card on mist, ink text, the logo the site already ships
// (/assets/img/email-logo-bww.png), a line that is only a link drawn as a
// coral button, and under a portal link (a quote, an invoice, a receipt, an
// agreement) "View or print (Save as PDF)". Every value is escaped; the
// plain-text part is the template's own text. core/templates.mjs calls this
// through setEmailLayout() for every email template without its own HTML.

import { esc } from "../../core/text.mjs";
import { CANONICAL_ORIGIN } from "../../core/context.mjs";

const INK = "#16161b", MIST = "#f4f4f6", LINE = "#ececee", CORAL = "#fb4d3d", MUTED = "#6b6b75";
const FONT = "system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const LINK_LINE = /^https:\/\/\S+$/;
const isPortal = (u) => u.startsWith(`${CANONICAL_ORIGIN}/p/`);

function buttonLabel(url, before) {
  const t = String(before || "").toLowerCase();
  if (/review/.test(url) || /review/.test(t)) return "Leave a review";
  if (!isPortal(url)) return "Open";
  if (/invoice|pay|balance/.test(t)) return "View and pay";
  if (/receipt/.test(t)) return "View your receipt";
  if (/agreement|sign/.test(t)) return "Review and sign";
  if (/quote|estimate/.test(t)) return "View your quote";
  return "Open";
}

export function emailLayout(text, { company } = {}) {
  const name = esc((company && company.name) || "Barta Window Washing");
  const phone = esc((company && company.phone) || "(763) 314-3400");
  const email = esc((company && company.email) || "office@bartawindowwashing.com");
  const paras = String(text ?? "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const parts = [];
  paras.forEach((p, i) => {
    if (LINK_LINE.test(p)) {
      const u = esc(p);
      parts.push(`<p style="margin:22px 0 8px"><a href="${u}" style="display:inline-block;padding:13px 24px;border-radius:999px;background:${CORAL};color:#ffffff;font-weight:700;text-decoration:none">${esc(buttonLabel(p, paras[i - 1]))}</a></p>`);
      if (isPortal(p)) parts.push(`<p style="margin:0 0 18px;font-size:13px"><a href="${u}" style="color:${MUTED}">View or print (Save as PDF)</a></p>`);
      return;
    }
    const linked = esc(p).replace(/https:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" style="color:#d0331f">${u}</a>`);
    parts.push(`<p style="margin:0 0 14px">${linked.replace(/\n/g, "<br>")}</p>`);
  });
  return `<!doctype html><html><body style="margin:0;padding:24px 12px;background:${MIST};font-family:${FONT};color:${INK};font-size:16px;line-height:1.5">`
    + `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid ${LINE};border-radius:20px;padding:24px">`
    + `<img src="${CANONICAL_ORIGIN}/assets/img/email-logo-bww.png" alt="${name}" width="148" style="display:block;margin:0 0 18px;height:auto">${parts.join("")}</div>`
    + `<p style="max-width:560px;margin:14px auto 0;text-align:center;font-size:12px;color:${MUTED}">${name} · Delano, MN · ${phone} · <a href="mailto:${email}" style="color:${MUTED}">${email}</a></p></body></html>`;
}
