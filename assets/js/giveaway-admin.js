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
    ["nudge", "3-day nudge", "Send Tue, Nov 3: each person's entry count + share link"],
    ["coupon", "Coupon to everyone who didn't win", "Send within 1 hour of the drawing (only people who ticked the optional coupon box)"],
    ["followup24", "24-hour follow-up", "Send Sat, Nov 7 to anyone who hasn't claimed"],
    ["followup48", "48-hour follow-up", "Send Sun, Nov 8 to anyone who hasn't claimed"],
  ];
  let key = "";
  try { key = sessionStorage.getItem(KEY) || ""; } catch (e) { /* private mode */ }
  let data = null;
  let query = "";
  let showAll = false;
  let filter = "all";
  const open = new Set();   // entrant cards left open across reloads
  const FILTERS = [
    ["all", "All", () => true],
    ["optin", "Want the $250 coupon", (e) => e.offers_opt_in],
    ["claimed", "Claimed $250", (e) => e.coupon_claimed_at],
    ["winners", "Winners", (e) => e.winner],
    ["check", "Check address", (e) => !(e.area && e.area.ok === true)],
    ["norotor", "Not in Rotor", (e) => !e.rotor_delivered],
    ["stop", "Replied STOP", (e) => e.sms_opt_out],
    ["dq", "Disqualified", (e) => e.disqualified],
  ];

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
      ["Want the $250 coupon", s.offers_opt_in], ["Coupons claimed", s.claimed], ["Winners", s.winners],
      ["Addresses to double-check", s.unverified], ["Not in Rotor", s.not_in_rotor], ["Out-of-area quote asks", s.outside],
    ];
    $("[data-gwa-stats]").innerHTML = tiles.map(([l, v]) =>
      `<div class="gwa-tile"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("");
    renderChart();
    renderLeaders();
    renderDraw();
    renderBroadcasts();
    renderList();
    renderOutside();
  }

  // Entries per day (Central time), new entries split from ones that came
  // in through someone's share link, as a simple SVG bar chart.
  function renderChart() {
    const el = $("[data-gwa-chart]");
    const day = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const counts = new Map();
    data.entrants.forEach((e) => {
      const d = day(e.created_at);
      const c = counts.get(d) || { direct: 0, link: 0 };
      if (e.referred_by) c.link++; else c.direct++;
      counts.set(d, c);
    });
    if (!counts.size) { el.innerHTML = '<p class="gwa-sub">No entries yet.</p>'; $("[data-gwa-chart-sub]").textContent = ""; return; }
    const days = [];
    const first = new Date([...counts.keys()].sort()[0] + "T12:00:00");
    const lastKey = day(new Date().toISOString());
    for (let d = new Date(first); day(d.toISOString()) <= lastKey && days.length < 60; d.setDate(d.getDate() + 1)) days.push(day(d.toISOString()));
    const max = Math.max(1, ...days.map((d) => { const c = counts.get(d); return c ? c.direct + c.link : 0; }));
    const W = Math.max(320, days.length * 28), H = 170, base = 140, bw = 18;
    const bars = days.map((d, i) => {
      const c = counts.get(d) || { direct: 0, link: 0 };
      const x = 14 + i * 28;
      const hd = (c.direct / max) * 120, hl = (c.link / max) * 120;
      const label = d.slice(5).replace("-", "/");
      return `<g><rect x="${x}" y="${base - hd}" width="${bw}" height="${hd}" class="gwa-bar-direct"><title>${d}: ${c.direct} direct</title></rect>`
        + `<rect x="${x}" y="${base - hd - hl}" width="${bw}" height="${hl}" class="gwa-bar-link"><title>${d}: ${c.link} via a share link</title></rect>`
        + (c.direct + c.link ? `<text x="${x + bw / 2}" y="${base - hd - hl - 4}" text-anchor="middle" class="gwa-bar-num">${c.direct + c.link}</text>` : "")
        + (i % Math.ceil(days.length / 12) === 0 ? `<text x="${x + bw / 2}" y="${base + 16}" text-anchor="middle" class="gwa-bar-day">${label}</text>` : "")
        + "</g>";
    }).join("");
    el.innerHTML = `<div class="gwa-chart-wrap"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Entries per day">${bars}
      <line x1="8" x2="${W - 8}" y1="${base}" y2="${base}" class="gwa-axis"/></svg></div>
      <p class="gwa-legend"><span class="gwa-key gwa-key-direct"></span> Entered on their own <span class="gwa-key gwa-key-link"></span> Came in through a friend's link</p>`;
    const linkShare = data.stats.entrants ? Math.round((data.stats.via_link / data.stats.entrants) * 100) : 0;
    $("[data-gwa-chart-sub]").textContent = `${linkShare}% came in through a share link`;
  }

  function renderLeaders() {
    const top = data.entrants.filter((e) => e.entries > 1).sort((a, b) => b.entries - a.entries).slice(0, 10);
    $("[data-gwa-leaders]").innerHTML = top.length
      ? `<ol class="gwa-leaders">${top.map((e) => `<li><span>${esc(e.first_name)} ${esc(e.last_name)}</span><b>${e.entries} entries</b><span class="gwa-sub">${e.entries - 1} friends</span></li>`).join("")}</ol>`
      : '<p class="gwa-sub">Nobody has brought in a friend yet.</p>';
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
      : "These go out as Rotor campaigns (tag Giveaway 2026). Counts below show who should get each one.";
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
    return `<details class="gwa-entrant ${e.disqualified ? "is-dq" : ""}" data-row="${esc(e.id)}"${open.has(e.id) ? " open" : ""}>
      <summary>
        <span class="gwa-name">${esc(e.first_name)} ${esc(e.last_name)}</span>
        <span class="gwa-entries">${e.entries} ${e.entries === 1 ? "entry" : "entries"}</span>
        ${e.winner ? `<span class="gwa-pill is-win">${e.winner === "bonus" ? "Bonus winner" : "Winner"}</span>` : ""}
        ${e.coupon_claimed_at ? '<span class="gwa-pill is-ok">Claimed $' + esc(main.dataset.coupon) + "</span>"
          : e.offers_opt_in ? '<span class="gwa-pill">Wants $' + esc(main.dataset.coupon) + " coupon</span>" : ""}
        ${e.rotor_delivered ? "" : '<span class="gwa-pill is-warn">Not in Rotor</span>'}
        ${e.disqualified ? '<span class="gwa-pill is-warn">Disqualified</span>' : ""}
        ${e.sms_opt_out ? '<span class="gwa-pill">Opted out</span>' : ""}
        ${failed ? '<span class="gwa-pill is-warn">Text failed</span>' : ""}
        ${area}
        <span class="gwa-sub gwa-addr">${esc(e.address)}</span>
      </summary>
      <div class="gwa-detail">
        <p>${esc(e.phone)} · entered ${esc(when(e.created_at))}${e.referred_by ? " · invited by " + esc(e.referred_by.name) : ""}${e.area && e.area.miles ? " · " + esc(e.area.miles) + " mi" : ""}</p>
        <p class="gwa-sub">Share code ${esc(e.code)}${sent ? " · texts sent: " + esc(sent) : ""}${e.rotor_delivered ? (e.rotor_existing ? " · in Rotor (already a lead, only tagged)" : " · in Rotor") : " · <strong>not in Rotor</strong>"}</p>
        <div class="gwa-row-actions">
          <a class="gwa-btn" href="tel:${esc(e.phone)}">Call</a>
          ${e.rotor_lead_id ? `<a class="gwa-btn gwa-btn-ghost" target="_blank" rel="noopener" href="https://app.getrotor.com/leads/${encodeURIComponent(e.rotor_lead_id)}/conversation">Open in Rotor</a>` : ""}
          ${TEMPLATES.map(([t, l]) => `<a class="gwa-btn gwa-btn-ghost" href="${esc(smsHref(e.phone, e.texts[t]))}" data-mark="${t}" data-id="${esc(e.id)}">Text: ${esc(l.split(" ")[0])}</a>`).join("")}
        </div>
        <form class="gwa-edit" data-edit="${esc(e.id)}">
          <div class="gwa-edit-grid">
            <label>First name<input name="first_name" value="${esc(e.first_name)}" required maxlength="60"></label>
            <label>Last name<input name="last_name" value="${esc(e.last_name)}" maxlength="60"></label>
            <label class="gwa-span2">Street<input name="street" value="${esc(e.street)}" required maxlength="200"></label>
            <label>City<input name="city" value="${esc(e.city)}" maxlength="80"></label>
            <label>ZIP<input name="zip" value="${esc(e.zip)}" maxlength="10" inputmode="numeric"></label>
          </div>
          <label class="gwa-check"><input type="checkbox" name="offers_opt_in"${e.offers_opt_in ? " checked" : ""}> Wants the $${esc(main.dataset.coupon)} coupon (gets coupon texts)</label>
          <label class="gwa-check"><input type="checkbox" name="coupon_claimed"${e.coupon_claimed_at ? " checked" : ""}> Claimed the $${esc(main.dataset.coupon)} coupon${e.coupon_claimed_at ? " (" + esc(when(e.coupon_claimed_at)) + (e.coupon_claimed_by === "office" ? ", marked by you" : "") + ")" : ""}</label>
          <label class="gwa-span2">Office note<textarea name="office_note" rows="2" maxlength="1000" placeholder="Called, left a voicemail…">${esc(e.office_note)}</textarea></label>
          <div class="gwa-row-actions"><button class="gwa-btn" type="submit">Save changes</button>
            ${e.rotor_delivered ? "" : `<button class="gwa-btn gwa-btn-ghost" type="button" data-act="resync_rotor" data-id="${esc(e.id)}">Send to Rotor again</button>`}</div>
        </form>
        <div class="gwa-row-actions">
          <button class="gwa-btn gwa-btn-ghost" data-act="disqualify" data-id="${esc(e.id)}" data-v="${e.disqualified ? "" : "1"}">${e.disqualified ? "Re-qualify" : "Disqualify"}</button>
          <button class="gwa-btn gwa-btn-ghost" data-act="set_opt_out" data-id="${esc(e.id)}" data-v="${e.sms_opt_out ? "" : "1"}">${e.sms_opt_out ? "Opted back in" : "Replied STOP"}</button>
          <button class="gwa-btn gwa-btn-danger" data-act="delete" data-id="${esc(e.id)}">Delete</button>
        </div>
      </div></details>`;
  }

  function renderList() {
    const q = query.trim().toLowerCase();
    const pick = (FILTERS.find((f) => f[0] === filter) || FILTERS[0])[2];
    $("[data-gwa-filters]").innerHTML = FILTERS.map(([id, label, fn]) =>
      `<button type="button" class="gwa-chip${id === filter ? " is-on" : ""}" data-filter="${id}" aria-pressed="${id === filter}">${esc(label)} <b>${data.entrants.filter(fn).length}</b></button>`).join("");
    $("[data-gwa-filters]").querySelectorAll("[data-filter]").forEach((b) => {
      b.onclick = () => { filter = b.dataset.filter; showAll = false; renderList(); };
    });
    const rows = data.entrants.filter(pick).filter((e) => !q || [e.first_name, e.last_name, e.phone, e.address, e.code]
      .join(" ").toLowerCase().includes(q) || digits(e.phone).includes(digits(q) || "x"));
    const shown = showAll ? rows : rows.slice(0, 150);
    const list = $("[data-gwa-list]");
    list.innerHTML = (shown.length ? shown.map(rowHTML).join("")
      : `<p class="gwa-sub">${data.entrants.length ? "Nobody matches." : "No entrants yet."}</p>`)
      + (rows.length > shown.length ? `<button class="gwa-btn gwa-btn-ghost gwa-mt" data-more>Show all ${rows.length}</button>` : "");
    const more = list.querySelector("[data-more]");
    if (more) more.onclick = () => { showAll = true; renderList(); };
    list.querySelectorAll("[data-mark]").forEach((a) => {
      a.addEventListener("click", () => {
        api("POST", { action: "mark_sent", id: a.dataset.id, template: a.dataset.mark }).catch(() => {});
      });
    });
    list.querySelectorAll("details[data-row]").forEach((d) => {
      d.addEventListener("toggle", () => { if (d.open) open.add(d.dataset.row); else open.delete(d.dataset.row); });
    });
    list.querySelectorAll("form[data-edit]").forEach((f) => {
      f.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const btn = f.querySelector('[type="submit"]');
        btn.disabled = true;
        const fields = {
          first_name: f.first_name.value, last_name: f.last_name.value,
          street: f.street.value, city: f.city.value, zip: f.zip.value,
          offers_opt_in: f.offers_opt_in.checked, coupon_claimed: f.coupon_claimed.checked,
          office_note: f.office_note.value,
        };
        try {
          const r = await api("POST", { action: "update", id: f.dataset.edit, fields });
          await load();
          toast(r.notes && r.notes.length ? "Saved. " + r.notes.join(" ") : "Saved.", !r.rotor_ok);
        } catch (e) { toast(e.message, true); btn.disabled = false; }
      });
    });
    list.querySelectorAll("[data-act]").forEach((b) => {
      b.onclick = async () => {
        const act = b.dataset.act;
        if (act === "delete" && !confirm("Delete this entrant? Their share link stops working and their number can enter again. (Their Rotor lead stays; delete it in Rotor if you want it gone.)")) return;
        try {
          await api("POST", { action: act, id: b.dataset.id, value: Boolean(b.dataset.v) });
          if (act === "delete") open.delete(b.dataset.id);
          await load();
          toast(act === "delete" ? "Deleted." : act === "resync_rotor" ? "Sent to Rotor." : "Saved.");
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
