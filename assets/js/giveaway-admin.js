/* Holiday Lights Giveaway office dashboard (docs/GIVEAWAY.md).
   Talks to /api/giveaway/admin with the admin key from sessionStorage. */
(function () {
  "use strict";
  const main = document.querySelector(".gwa");
  if (!main) return;
  const $ = (s, el) => (el || document).querySelector(s);
  const API = main.dataset.api;
  const KEY = "gwa-key";
  const TEMPLATES = [
    ["nudge", "3-day nudge", "Send Tue, Nov 4: each person's entry count + share link"],
    ["coupon", "Coupon to everyone who didn't win", "Send within 1 hour of the drawing"],
    ["followup24", "24-hour follow-up", "Send Sat, Nov 8 to anyone who hasn't claimed"],
    ["followup48", "48-hour follow-up", "Send Sun, Nov 9 to anyone who hasn't claimed"],
  ];
  let key = "";
  try { key = sessionStorage.getItem(KEY) || ""; } catch (e) { /* private mode */ }
  let data = null;
  let query = "";
  let showAll = false;

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const digits = (p) => String(p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const smsHref = (phone, body) => {
    const d = digits(phone);
    return d.length === 10 ? "sms:+1" + d + "?&body=" + encodeURIComponent(body) : "#";
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-US",
    { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const toast = (msg, bad) => {
    const t = $("[data-gwa-toast]");
    t.textContent = msg;
    t.className = "gwa-toast" + (bad ? " is-bad" : "");
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.hidden = true; }, 3800);
  };

  async function api(method, body, query) {
    const res = await fetch(API + (query || ""), {
      method,
      headers: { Authorization: "Bearer " + key, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { signOut("Wrong admin key."); throw new Error("Wrong admin key."); }
    const b = await res.json().catch(() => ({}));
    if (!res.ok || !b.ok) throw new Error(b.error || "Request failed (" + res.status + ")");
    return b;
  }

  /* ---- auth ---- */
  function signOut(msg) {
    key = "";
    try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    $("[data-gwa-body]").hidden = true;
    $("[data-gwa-authed]").hidden = true;
    $("[data-gwa-login]").hidden = false;
    const err = $("[data-gwa-login-error]");
    err.hidden = !msg;
    err.textContent = msg || "";
  }
  $("[data-gwa-login-form]").addEventListener("submit", (ev) => {
    ev.preventDefault();
    key = ev.target.key.value.trim();
    try { sessionStorage.setItem(KEY, key); } catch (e) { /* ignore */ }
    load();
  });
  $("[data-gwa-logout]").addEventListener("click", () => signOut(""));
  $("[data-gwa-refresh]").addEventListener("click", () => load());
  $("[data-gwa-csv]").addEventListener("click", async () => {
    try {
      const res = await fetch(API + "?format=csv", { headers: { Authorization: "Bearer " + key } });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "giveaway-entrants.csv";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    } catch (e) { toast(e.message, true); }
  });

  async function load() {
    if (!key) { signOut(""); return; }
    try {
      data = await api("GET");
      $("[data-gwa-login]").hidden = true;
      $("[data-gwa-body]").hidden = false;
      $("[data-gwa-authed]").hidden = false;
      render();
    } catch (e) {
      if (key) { $("[data-gwa-login]").hidden = false; const err = $("[data-gwa-login-error]"); err.textContent = e.message; err.hidden = false; }
    }
  }

  /* ---- render ---- */
  function render() {
    const s = data.stats;
    const tiles = [
      ["Entrants", s.entrants], ["Total entries", s.entries], ["Came in via a share link", s.via_link],
      ["Coupons claimed", s.claimed], ["Addresses to double-check", s.unverified], ["Out-of-area quote asks", s.outside],
    ];
    $("[data-gwa-stats]").innerHTML = tiles.map(([l, v]) =>
      `<div class="gwa-tile"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("");
    renderDraw();
    renderBroadcasts();
    renderList();
    renderOutside();
  }

  function renderDraw() {
    const c = data.config;
    const el = $("[data-gwa-draw]");
    $("[data-gwa-draw-when]").textContent = c.dates.draw + (c.open ? " · entries open until " + c.dates.closes : " · entries closed");
    const d = data.draw;
    if (!d) {
      el.innerHTML = `<p>Draws ${c.winners} winners at random, weighted by entries. If a winner came in through someone's share link, that person wins too.</p>
        <button class="gwa-btn gwa-btn-big" data-gwa-do-draw>${c.open ? "Draw early (entries still open)" : "Draw " + c.winners + " winners"}</button>`;
      $("[data-gwa-do-draw]").onclick = async () => {
        if (c.open && !confirm("Entries are still open. Draw now anyway?")) return;
        try { data.draw = (await api("POST", { action: "draw", early: c.open })).draw; await load(); toast("Winners drawn!"); }
        catch (e) { toast(e.message, true); }
      };
      return;
    }
    const byId = new Map(data.entrants.map((e) => [e.id, e]));
    el.innerHTML = `<p class="gwa-sub">Drawn ${esc(when(d.drawn_at))} from ${esc(d.total_entries)} entries (${esc(d.eligible_entrants)} people).</p>
      <div class="gwa-winners">${d.winners.map((w) => {
        const e = byId.get(w.id) || {};
        return `<div class="gwa-winner ${w.kind === "bonus" ? "is-bonus" : ""}">
          <span class="gwa-pill">${w.kind === "bonus" ? "Friend bonus" : "Drawn winner"}${w.alternate ? " · alternate" : ""}</span>
          <h3>${esc(w.name)}</h3>
          <p>${w.kind === "bonus" ? "Invited " + esc(w.because_of_name) : esc(w.entries) + (w.entries === 1 ? " entry" : " entries") + " (" + esc(w.odds) + " tickets)"}</p>
          <p class="gwa-sub">${esc(e.address || "")}</p>
          <div class="gwa-row-actions">
            <a class="gwa-btn" href="tel:${esc(e.phone)}">Call</a>
            ${e.winner_text ? `<a class="gwa-btn gwa-btn-ghost" href="${esc(smsHref(e.phone, e.winner_text))}">Text "you won"</a>` : ""}
            ${w.kind === "drawn" ? `<button class="gwa-btn gwa-btn-ghost" data-redraw="${esc(w.id)}">Replace (no response)</button>` : ""}
          </div></div>`;
      }).join("")}</div>
      ${d.replaced && d.replaced.length ? `<p class="gwa-sub">Replaced: ${d.replaced.map((r) => esc(r.name)).join(", ")}</p>` : ""}
      <button class="gwa-btn gwa-btn-ghost gwa-mt" data-gwa-undo>Undo drawing</button>`;
    el.querySelectorAll("[data-redraw]").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("Replace this winner with a new random winner?")) return;
        try { await api("POST", { action: "redraw", id: b.dataset.redraw }); await load(); toast("Alternate drawn."); }
        catch (e) { toast(e.message, true); }
      };
    });
    $("[data-gwa-undo]").onclick = async () => {
      const phrase = prompt('This erases the drawing. Type UNDO DRAW to confirm.');
      if (phrase === null) return;
      try { await api("POST", { action: "undo_draw", confirm: phrase }); await load(); toast("Drawing undone."); }
      catch (e) { toast(e.message, true); }
    };
  }

  function renderBroadcasts() {
    $("[data-gwa-sms-state]").textContent = data.sms_ready
      ? "Automatic texting is on (Twilio)."
      : "Automatic texting isn't set up. Use Export CSV (it has each person's own text) or the text links on each entrant.";
    const sample = data.entrants[0];
    $("[data-gwa-broadcasts]").innerHTML = TEMPLATES.map(([t, label, hint]) => {
      const n = data.audiences[t] || 0;
      const needsDraw = t !== "nudge" && !data.draw;
      return `<div class="gwa-bc">
        <div><h3>${esc(label)}</h3><p class="gwa-sub">${esc(hint)}</p>
        ${sample ? `<p class="gwa-preview">${esc(sample.texts[t])}</p>` : ""}</div>
        <div class="gwa-bc-side"><b>${n}</b><span>to send</span>
        ${data.sms_ready ? `<button class="gwa-btn" data-send="${t}" ${n && !needsDraw ? "" : "disabled"}>${needsDraw ? "After the drawing" : "Send to " + n}</button>` : ""}
        <div class="gwa-progress" data-progress="${t}" hidden></div></div></div>`;
    }).join("");
    document.querySelectorAll("[data-send]").forEach((b) => { b.onclick = () => broadcast(b.dataset.send, b); });
  }

  async function broadcast(t, btn) {
    const n = data.audiences[t];
    if (!confirm(`Text ${n} people now?`)) return;
    btn.disabled = true;
    const bar = document.querySelector(`[data-progress="${t}"]`);
    bar.hidden = false;
    let sent = 0, failed = 0;
    try {
      for (;;) {
        const r = await api("POST", { action: "send_batch", template: t });
        sent += r.sent; failed += r.failed;
        bar.textContent = `Sent ${sent}${failed ? ", failed " + failed : ""}${r.remaining ? ", " + r.remaining + " to go…" : ". Done."}`;
        if (!r.remaining || r.sent + r.failed === 0) break;
      }
      toast(`Sent ${sent} texts${failed ? ", " + failed + " failed (see list)" : ""}.`, Boolean(failed));
    } catch (e) { toast(e.message, true); }
    await load();
  }

  function rowHTML(e) {
    const area = e.area && e.area.ok === true ? "" : `<span class="gwa-pill is-warn">${e.area && e.area.ok === false ? "Out of area" : "Check address"}</span>`;
    const sent = TEMPLATES.filter(([t]) => e.sms[t]).map(([, l]) => l.split(" ")[0]).join(", ");
    const failed = TEMPLATES.filter(([t]) => e.sms[t + "_failed"]).length;
    return `<details class="gwa-entrant ${e.disqualified ? "is-dq" : ""}">
      <summary>
        <span class="gwa-name">${esc(e.first_name)} ${esc(e.last_name)}</span>
        <span class="gwa-entries">${e.entries} ${e.entries === 1 ? "entry" : "entries"}</span>
        ${e.winner ? `<span class="gwa-pill is-win">${e.winner === "bonus" ? "Bonus winner" : "Winner"}</span>` : ""}
        ${e.coupon_claimed_at ? '<span class="gwa-pill is-ok">Claimed $' + esc(main.dataset.coupon) + "</span>" : ""}
        ${e.disqualified ? '<span class="gwa-pill is-warn">Disqualified</span>' : ""}
        ${e.sms_opt_out ? '<span class="gwa-pill">Opted out</span>' : ""}
        ${failed ? '<span class="gwa-pill is-warn">Text failed</span>' : ""}
        ${area}
        <span class="gwa-sub gwa-addr">${esc(e.address)}</span>
      </summary>
      <div class="gwa-detail">
        <p>${esc(e.phone)} · entered ${esc(when(e.created_at))}${e.referred_by ? " · invited by " + esc(e.referred_by.name) : ""}${e.area && e.area.miles ? " · " + esc(e.area.miles) + " mi" : ""}</p>
        <p class="gwa-sub">Share code ${esc(e.code)}${sent ? " · texts sent: " + esc(sent) : ""}${e.rotor_delivered ? " · in Rotor" : " · <strong>not in Rotor</strong>"}</p>
        <div class="gwa-row-actions">
          <a class="gwa-btn" href="tel:${esc(e.phone)}">Call</a>
          ${e.rotor_lead_id ? `<a class="gwa-btn gwa-btn-ghost" target="_blank" rel="noopener" href="https://app.getrotor.com/leads/${encodeURIComponent(e.rotor_lead_id)}/conversation">Open in Rotor</a>` : ""}
          ${TEMPLATES.map(([t, l]) => `<a class="gwa-btn gwa-btn-ghost" href="${esc(smsHref(e.phone, e.texts[t]))}" data-mark="${t}" data-id="${esc(e.id)}">Text: ${esc(l.split(" ")[0])}</a>`).join("")}
        </div>
        <div class="gwa-row-actions">
          <button class="gwa-btn gwa-btn-ghost" data-act="disqualify" data-id="${esc(e.id)}" data-v="${e.disqualified ? "" : "1"}">${e.disqualified ? "Re-qualify" : "Disqualify"}</button>
          <button class="gwa-btn gwa-btn-ghost" data-act="set_opt_out" data-id="${esc(e.id)}" data-v="${e.sms_opt_out ? "" : "1"}">${e.sms_opt_out ? "Opted back in" : "Replied STOP"}</button>
          <button class="gwa-btn gwa-btn-danger" data-act="delete" data-id="${esc(e.id)}">Delete</button>
        </div>
      </div></details>`;
  }

  function renderList() {
    const q = query.trim().toLowerCase();
    const rows = data.entrants.filter((e) => !q || [e.first_name, e.last_name, e.phone, e.address, e.code]
      .join(" ").toLowerCase().includes(q) || digits(e.phone).includes(digits(q) || "x"));
    const shown = showAll ? rows : rows.slice(0, 150);
    const list = $("[data-gwa-list]");
    list.innerHTML = (shown.length ? shown.map(rowHTML).join("") : '<p class="gwa-sub">No entrants yet.</p>')
      + (rows.length > shown.length ? `<button class="gwa-btn gwa-btn-ghost gwa-mt" data-more>Show all ${rows.length}</button>` : "");
    const more = list.querySelector("[data-more]");
    if (more) more.onclick = () => { showAll = true; renderList(); };
    list.querySelectorAll("[data-mark]").forEach((a) => {
      a.addEventListener("click", () => {
        api("POST", { action: "mark_sent", id: a.dataset.id, template: a.dataset.mark }).catch(() => {});
      });
    });
    list.querySelectorAll("[data-act]").forEach((b) => {
      b.onclick = async () => {
        const act = b.dataset.act;
        if (act === "delete" && !confirm("Delete this entrant? Their share link stops working. (Rotor isn't touched.)")) return;
        try {
          await api("POST", { action: act, id: b.dataset.id, value: Boolean(b.dataset.v) });
          await load();
          toast("Saved.");
        } catch (e) { toast(e.message, true); }
      };
    });
  }

  function renderOutside() {
    const el = $("[data-gwa-outside]");
    el.innerHTML = data.outside.length ? data.outside.map((o) =>
      `<div class="gwa-out"><b>${esc(o.first_name)} ${esc(o.last_name)}</b> · <a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>
       <span class="gwa-sub">${esc(o.address)}${o.miles ? " · " + esc(o.miles) + " mi" : ""} · ${esc(when(o.created_at))}</span></div>`).join("")
      : '<p class="gwa-sub">None yet. These people are also in Rotor, tagged "Giveaway - Out of Area".</p>';
  }

  $("[data-gwa-search]").addEventListener("input", (ev) => { query = ev.target.value; showAll = false; if (data) renderList(); });
  $("[data-gwa-wipe]").addEventListener("click", async () => {
    const phrase = prompt("This deletes every giveaway entrant and the drawing. Type DELETE ALL to confirm.");
    if (phrase === null) return;
    try { await api("POST", { action: "delete_all", confirm: phrase }); await load(); toast("All giveaway data deleted."); }
    catch (e) { toast(e.message, true); }
  });

  load();
})();
