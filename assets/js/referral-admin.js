/* =====================================================================
   Barta Window Washing — Referral dashboard (admin/referrals.html)
   Vanilla JS, no dependencies. Unlike the marketing pages this is an app
   screen: without this file it shows the key prompt and nothing else.
   Every record it renders comes from /api/referral/admin
   (docs/REFERRAL-PROGRAM.md → Admin) and is written into cloned <template>
   markup with textContent, never as HTML assembled from server data.
   ===================================================================== */
(function () {
  "use strict";
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));

  const main = $("main[data-api]");
  if (!main) return;

  /* The offer, business name and office number ride on <main>'s data
     attributes (sitedata via build/referral_admin_page.py), so the text
     templates below print exactly what the pages promise and nothing here
     needs editing when the amounts change. */
  const cfg = {
    api: main.dataset.api,
    friendOff: Number(main.dataset.friendOff),
    credit: Number(main.dataset.credit),
    gift: Number(main.dataset.gift),
    biz: main.dataset.biz || "",
    phone: main.dataset.phone || "",
  };
  const STORE_KEY = "referralAdminKey";
  const REFRESH_MS = 60 * 1000;
  const money = (n) => "$" + n;
  const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

  /* ---- Elements ---- */
  const keyScreen = $("#ra-key"), keyForm = $("#ra-key-form"), keyInput = $("#ra-key-input");
  const keyToggle = $("#ra-key-toggle"), keyErr = $("#ra-key-err"), keySubmit = $("#ra-key-submit");
  const dash = $("#ra-dash"), barActions = $("#ra-bar-actions");
  const refreshBtn = $("#ra-refresh"), exportBtn = $("#ra-export"), signoutBtn = $("#ra-signout");
  const statsEl = $("#ra-stats"), tabs = $$('.ra-tabs [role="tab"]');
  const searchInput = $("#ra-search"), filters = $("#ra-filters"), chips = $$(".ra-chip", filters);
  const resultsEl = $("#ra-results"), updatedEl = $("#ra-updated"), loadingEl = $("#ra-loading");
  const panelReferrals = $("#ra-panel-referrals"), listEl = $("#ra-list"), emptyEl = $("#ra-empty");
  const panelReferrers = $("#ra-panel-referrers"), tableWrap = $(".ra-table-wrap", panelReferrers);
  const referrersBody = $("#ra-referrers"), referrersEmpty = $("#ra-referrers-empty");
  const toastEl = $("#ra-toast"), dialog = $("#ra-confirm");
  const tplCard = $("#ra-tpl-card"), tplRow = $("#ra-tpl-referrer");

  /* Status wording comes from the <select> options the build rendered, so
     the chips, the pills and the toasts all say what referral_admin_page.py
     says, and an unknown status from the server still shows as itself. */
  const STATUS_LABEL = {};
  $$("option", tplCard.content).forEach((o) => { STATUS_LABEL[o.value] = o.textContent; });
  const STATUSES = Object.keys(STATUS_LABEL);
  const statusLabel = (s) => STATUS_LABEL[s] || String(s || "");

  const state = { key: "", authed: false, data: null, filter: "all", query: "", view: "referrals", loadedAt: 0 };
  const dirtyNotes = new Map(); // referral id → office note typed but not yet saved
  let openIssue = null;         // referral id whose Issue-reward panel is open
  let loading = null;           // the in-flight GET, so refreshes never overlap

  /* sessionStorage, not localStorage, on purpose: a lost or shared office
     phone shouldn't stay signed in forever. Wrapped because private modes
     can throw, in which case the key simply lives in memory for the tab. */
  const storage = {
    get() { try { return sessionStorage.getItem(STORE_KEY) || ""; } catch (e) { return ""; } },
    set(v) { try { sessionStorage.setItem(STORE_KEY, v); } catch (e) { /* memory only */ } },
    clear() { try { sessionStorage.removeItem(STORE_KEY); } catch (e) { /* nothing stored */ } },
  };

  /* ---- Formatters ---- */
  // Same rule as the API: ten US digits, a leading country code dropped.
  const digits = (v) => {
    let d = String(v || "").replace(/\D/g, "");
    if (d.length === 11 && d[0] === "1") d = d.slice(1);
    return d;
  };
  const fmtPhone = (v) => {
    const d = digits(v);
    return d.length === 10 ? "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6) : String(v || "");
  };
  const telHref = (v) => { const d = digits(v); return d.length === 10 ? "tel:+1" + d : ""; };
  const fullName = (first, last) => [first, last].filter(Boolean).join(" ").trim();
  const parseDate = (iso) => { const d = new Date(iso || ""); return isNaN(d) ? null : d; };
  const fmtDate = (iso) => {
    const d = parseDate(iso);
    if (!d) return "";
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  };
  const fmtExact = (iso) => {
    const d = parseDate(iso);
    return d ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
  };
  /* "5 min ago" for anything recent, a plain date once it's a month old:
     the office cares how long a new referral has been waiting, not the
     exact minute (that's in the title). */
  const relTime = (iso) => {
    const d = parseDate(iso);
    if (!d) return "";
    const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
    const days = Math.round(h / 24);
    if (days === 1) return "yesterday";
    if (days < 7) return days + " days ago";
    if (days < 30) { const w = Math.round(days / 7); return w + (w === 1 ? " week ago" : " weeks ago"); }
    return fmtDate(iso);
  };
  const setTime = (el, iso) => {
    el.textContent = relTime(iso);
    el.title = fmtExact(iso);
    if (el.tagName === "TIME") el.dateTime = iso || "";
  };
  // "$<amount> credit" / "$<amount> gift card", using the recorded amount when
  // there is one and the page's configured amounts otherwise.
  const rewardLabel = (type, amount) => {
    const n = typeof amount === "number" ? amount : (type === "giftcard" ? cfg.gift : cfg.credit);
    return money(n) + (type === "giftcard" ? " gift card" : " credit");
  };
  const prefLabel = (pref) => (pref === "giftcard" ? money(cfg.gift) + " gift card" : money(cfg.credit) + " credit");

  /* ---- Text-message templates ----
     Verbatim from the contract, so a text sent by hand from here reads the
     same as one Twilio would have sent automatically. */
  const shareUrl = (code) => location.origin + "/r/" + (code || "");
  const smsHref = (phone, body) => {
    const d = digits(phone);
    return d.length === 10 ? "sms:+1" + d + "?&body=" + encodeURIComponent(body) : "";
  };
  const referrerOf = (r) => ((state.data && state.data.referrers) || []).find((p) => p.id === r.referrer_id) || null;
  const referrerNames = (r) => {
    const p = referrerOf(r);
    if (p) return [p.first_name || "", p.last_name || ""];
    const parts = String(r.referrer_name || "").trim().split(/\s+/);
    return [parts[0] || "", parts.slice(1).join(" ")];
  };
  const friendText = (r) => {
    const names = referrerNames(r);
    const initial = names[1] ? names[1].charAt(0).toUpperCase() : "";
    // A referrer who gave no last name would otherwise read "Alex . referred".
    const who = (initial ? names[0] + " " + initial + "." : names[0]) || "A friend";
    return "Hi " + (r.first_name || "there") + "! " + who + " referred you to " + cfg.biz
      + ", so your first service is " + money(cfg.friendOff) + " off. Claim it here: " + shareUrl(r.code)
      + " or call " + cfg.phone + ". Reply STOP to opt out.";
  };
  const referrerText = (r) => {
    if (r.status === "rewarded" && r.reward) {
      return "Great news from " + cfg.biz + ": " + (r.first_name || "your friend") + " booked, so your "
        + rewardLabel(r.reward.type, r.reward.amount) + " is ready. Thanks for spreading the word!";
    }
    // The admin list carries each referrer's tracking link as status_url so
    // the office can resend it; a payload without it just drops the sentence.
    const p = referrerOf(r);
    const n = p && p.referred ? p.referred : 1;
    return "Thanks for referring " + n + " friend(s) to " + cfg.biz + "! You earn a " + money(cfg.credit)
      + " credit (or a " + money(cfg.gift) + " gift card) for each one who books."
      + (p && p.status_url ? " Track your referrals: " + p.status_url : "");
  };

  /* ---- API ----
     fetch that resolves to { res, data } so callers branch on status and
     body together; a non-JSON body (a host's 404 page) leaves data null. */
  const api = (query, options) => {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({ Authorization: "Bearer " + state.key, Accept: "application/json" }, opts.headers || {});
    return fetch(cfg.api + (query || ""), opts)
      .then((res) => res.json().catch(() => null).then((data) => ({ res, data })));
  };
  const post = (body) => api("", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const fail = (msg) => Object.assign(new Error(msg), { user: true });

  const NOT_CONFIGURED = "The dashboard isn't set up yet: REFERRAL_ADMIN_KEY hasn't been set in Netlify "
    + "(Site configuration → Environment variables). Add it, redeploy, and try again.";
  const SIGNED_OUT = "Your key was rejected, so you've been signed out. Enter it again to continue.";
  /* One sentence per failure the office can actually act on. */
  const describe = (res, data) => {
    const server = data && typeof data.error === "string" ? data.error : "";
    if (!res) return "Couldn't reach the server. Check your connection and try again.";
    if (res.status === 401) return "That key didn't match. Check it and try again.";
    if (res.status === 503) return !server || /REFERRAL_ADMIN_KEY/.test(server) ? NOT_CONFIGURED : server;
    // A JSON 404 is the API talking ("Referral not found." after someone
    // else deleted it); a bare 404/405 means there is no API on this host.
    if (res.status === 404 || res.status === 405)
      return server || "The referral API isn't available on this host. It runs on the Netlify deploy, not the GitHub Pages preview.";
    return server || ("Something went wrong (HTTP " + res.status + ").");
  };

  /* ---- Toast (the page's one polite live region) ---- */
  let toastTimer;
  const toast = (msg, isError) => {
    toastEl.textContent = msg;
    toastEl.classList.toggle("is-error", Boolean(isError));
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), isError ? 7000 : 3500);
  };

  /* ---- Screens ---- */
  const setErr = (msg, neutral) => {
    keyErr.textContent = msg || "";
    keyErr.hidden = !msg;
    keyErr.classList.toggle("is-note", Boolean(neutral));
  };
  const showKey = (msg, neutral) => {
    state.authed = false;
    dash.hidden = true;
    barActions.hidden = true;
    keyScreen.hidden = false;
    setErr(msg, neutral);
    keyInput.value = "";
    keyInput.focus();
  };
  const showDash = () => {
    state.authed = true;
    keyScreen.hidden = true;
    dash.hidden = false;
    barActions.hidden = false;
    setErr("");
  };
  const signOut = (msg, neutral) => {
    state.key = "";
    state.data = null;
    dirtyNotes.clear();
    openIssue = null;
    storage.clear();
    if (dialog && dialog.open) dialog.close();
    showKey(msg, neutral);
  };

  /* ---- Loading ---- */
  const setBusy = (on) => {
    refreshBtn.disabled = on;
    refreshBtn.setAttribute("aria-busy", on ? "true" : "false");
    listEl.setAttribute("aria-busy", on ? "true" : "false");
  };
  // Defensive copy of the list payload: arrays where arrays are expected,
  // newest first as the contract says (harmless if the server already did).
  const normalize = (data) => ({
    stats: data.stats && typeof data.stats === "object" ? data.stats : {},
    referrals: (Array.isArray(data.referrals) ? data.referrals : []).filter((r) => r && r.id)
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))),
    referrers: (Array.isArray(data.referrers) ? data.referrers : []).filter((p) => p && p.id),
  });
  /* GET everything. Serves the first sign-in (a 401 stays on the key screen
     with the reason), manual and timed refreshes (a 401 there means the key
     was rotated, so sign out), and the boot with a remembered key. */
  const load = (opts) => {
    if (loading) return loading;
    const silent = Boolean(opts && opts.silent);
    setBusy(true);
    if (!state.data) loadingEl.hidden = false;
    loading = api("").then(({ res, data }) => {
      if (res.status === 401) {
        if (state.authed) signOut(SIGNED_OUT);
        else { storage.clear(); setErr(describe(res, data)); keyInput.focus(); }
        return false;
      }
      if (!res.ok || !data || !data.ok) throw fail(describe(res, data));
      state.data = normalize(data);
      state.loadedAt = Date.now();
      if (!state.authed) { storage.set(state.key); showDash(); }
      render();
      return true;
    }).catch((err) => {
      const user = Boolean(err && err.user);
      if (!user) console.error(err);
      const msg = user ? err.message : describe(null);
      if (!state.authed) { setErr(msg); keyInput.focus(); }
      else if (!silent) toast(msg, true);
      else updatedEl.textContent = "Couldn't refresh, showing the last load.";
      return false;
    }).finally(() => {
      loading = null;
      setBusy(false);
      loadingEl.hidden = true;
    });
    return loading;
  };

  /* Mirror of the server's adminStats/referrerSummary so the tiles and
     counts move the moment an action lands, without a second round trip.
     The next refresh replaces these with the server's own numbers. */
  const recompute = () => {
    const d = state.data;
    const by = {};
    STATUSES.forEach((s) => { by[s] = 0; });
    let owed = 0, credit = 0, cards = 0;
    d.referrals.forEach((r) => {
      if (by[r.status] !== undefined) by[r.status]++;
      if (r.status === "booked") owed++;
      if (r.status === "rewarded" && r.reward && typeof r.reward.amount === "number") {
        if (r.reward.type === "giftcard") cards++; else credit += r.reward.amount;
      }
    });
    d.stats = { total: d.referrals.length, by_status: by, rewards_owed: owed, credit_issued: credit, gift_cards_issued: cards };
    d.referrers.forEach((p) => {
      const mine = d.referrals.filter((r) => r.referrer_id === p.id);
      p.referred = mine.length;
      p.booked = mine.filter((r) => r.status === "booked" || r.status === "rewarded").length;
      p.rewarded = mine.filter((r) => r.status === "rewarded").length;
    });
  };
  const applyReferral = (rec) => {
    if (!rec || !rec.id) return;
    const i = state.data.referrals.findIndex((r) => r.id === rec.id);
    if (i >= 0) state.data.referrals[i] = rec; else state.data.referrals.unshift(rec);
    recompute();
  };
  const removeReferral = (id) => {
    state.data.referrals = state.data.referrals.filter((r) => r.id !== id);
    dirtyNotes.delete(id);
    if (openIssue === id) openIssue = null;
    recompute();
  };
  // set_reward_pref answers with the bare referrer record (no counts), so
  // merge it over what's already listed rather than replacing.
  const applyReferrer = (rec) => {
    if (!rec || !rec.id) return;
    const i = state.data.referrers.findIndex((p) => p.id === rec.id);
    if (i >= 0) state.data.referrers[i] = Object.assign({}, state.data.referrers[i], rec);
    else state.data.referrers.push(rec);
    recompute();
  };

  /* POST one action. Resolves with the response body on success; on any
     failure it has already told the office why and resolves null. `busy`
     is the card or row being changed, dimmed while the request runs. */
  const act = (body, busy) => {
    if (busy) busy.classList.add("is-busy");
    return post(body).then(({ res, data }) => {
      if (res.status === 401) { signOut(SIGNED_OUT); return null; }
      if (!res.ok || !data || !data.ok) { toast(describe(res, data), true); return null; }
      return data;
    }).catch((err) => {
      console.error(err);
      toast(describe(null), true);
      return null;
    }).finally(() => { if (busy) busy.classList.remove("is-busy"); });
  };

  /* ---- Search (same fields and digit rule as the server's matchesQuery) ---- */
  const matches = (r, q) => {
    const needle = String(q || "").trim().toLowerCase();
    if (!needle) return true;
    const hay = [r.first_name, r.last_name, r.phone, r.phone_digits, r.email, r.referrer_name,
      r.referrer_phone, r.code, r.address, r.id].filter(Boolean).join(" ").toLowerCase();
    if (hay.includes(needle)) return true;
    const d = needle.replace(/\D/g, "");
    return d.length >= 3 && (String(r.phone_digits || digits(r.phone)).includes(d) || digits(r.referrer_phone).includes(d));
  };
  const matchesReferrer = (p, q) => {
    const needle = String(q || "").trim().toLowerCase();
    if (!needle) return true;
    const hay = [p.first_name, p.last_name, p.phone, p.email, p.code, p.id].filter(Boolean).join(" ").toLowerCase();
    if (hay.includes(needle)) return true;
    const d = needle.replace(/\D/g, "");
    return d.length >= 3 && digits(p.phone).includes(d);
  };
  const visibleReferrals = () =>
    state.data.referrals.filter((r) => (state.filter === "all" || r.status === state.filter) && matches(r, state.query));
  const visibleReferrers = () => state.data.referrers.filter((p) => matchesReferrer(p, state.query));

  /* ---- Focus across re-renders ----
     Lists are rebuilt from scratch after every change, which would drop
     keyboard focus on the floor. Remember which control in which record
     had it and put it back on the fresh copy; if that record is gone (it
     left the current filter, or was deleted) land on the results line so
     a screen reader hears where things stand. */
  const hook = (root, name) => root.querySelector('[data-f="' + name + '"]');
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
  const rememberFocus = (container) => {
    const a = document.activeElement;
    if (!a || !container.contains(a)) return null;
    const rec = a.closest("[data-id]");
    return { id: rec ? rec.dataset.id : "", hook: a.dataset.f || "" };
  };
  const focusIn = (container, id, name) => {
    const rec = id ? container.querySelector('[data-id="' + cssEsc(id) + '"]') : null;
    const el = rec && name ? hook(rec, name) : null;
    if (el && !el.disabled && !el.hidden) el.focus(); else resultsEl.focus();
  };
  const restoreFocus = (container, memo) => { if (memo) focusIn(container, memo.id, memo.hook); };

  /* ---- Rendering ---- */
  const setText = (root, name, text) => { const el = hook(root, name); if (el) el.textContent = text; return el; };
  const setLink = (root, name, text, href) => {
    const el = hook(root, name);
    el.textContent = text;
    if (href) el.href = href; else el.removeAttribute("href");
    return el;
  };

  const renderStats = () => {
    const s = state.data.stats, by = s.by_status || {};
    const owed = typeof s.rewards_owed === "number" ? s.rewards_owed : by.booked;
    const vals = {
      new: by.new, contacted: by.contacted, quoted: by.quoted, booked: owed, rewarded: by.rewarded,
      credit: money(s.credit_issued || 0), giftcards: s.gift_cards_issued,
    };
    $$("[data-stat]", statsEl).forEach((el) => {
      const v = vals[el.dataset.stat];
      el.textContent = v == null ? "0" : String(v);
    });
    const total = typeof s.total === "number" ? s.total : state.data.referrals.length;
    $$("[data-count]", dash).forEach((el) => {
      const k = el.dataset.count;
      const v = k === "total" || k === "all" ? total : k === "referrers" ? state.data.referrers.length : by[k];
      el.textContent = v == null ? "0" : String(v);
    });
  };

  const renderMeta = () => {
    let txt;
    if (state.view === "referrers") {
      const all = state.data.referrers.length, n = visibleReferrers().length;
      txt = n === all ? plural(all, "referrer") : n + " of " + plural(all, "referrer") + " shown";
    } else {
      const all = state.data.referrals.length, n = visibleReferrals().length;
      txt = n === all ? plural(all, "referral") : n + " of " + plural(all, "referral") + " shown";
    }
    // Only touch the live region when the count changes, or every timed
    // refresh would be announced.
    if (resultsEl.textContent !== txt) resultsEl.textContent = txt;
    updatedEl.textContent = state.loadedAt ? "Updated " + relTime(new Date(state.loadedAt).toISOString()) : "";
  };

  const onStatusChange = (r, node, sel) => {
    const next = sel.value;
    if (next === r.status) return;
    if (next === "rewarded") {
      // Rewards go through issue_reward so the type, amount and date are
      // recorded; the select just opens that panel.
      sel.value = r.status;
      const panel = hook(node, "issue-panel");
      if (panel.hidden) hook(node, "issue").click();
      else ($('input[type="radio"]:checked', panel) || $('input[type="radio"]', panel)).focus();
      return;
    }
    act({ action: "set_status", id: r.id, status: next }, node).then((data) => {
      if (!data) { sel.value = r.status; return; }
      applyReferral(data.referral);
      render();
      toast((fullName(r.first_name, r.last_name) || "Referral") + " marked " + statusLabel(next) + ".");
      focusIn(listEl, r.id, "status-select");
    });
  };

  const buildCard = (r) => {
    const node = tplCard.content.firstElementChild.cloneNode(true);
    const id = String(r.id);
    node.dataset.id = id;
    // Per-card ids for the label/for pairs and the radio group name.
    const uid = "ra-" + id.replace(/[^a-z0-9_-]/gi, "");
    const name = fullName(r.first_name, r.last_name) || "Unnamed friend";
    setText(node, "name", name);

    const pill = hook(node, "status");
    pill.textContent = statusLabel(r.status);
    pill.dataset.status = String(r.status || "");
    const dup = hook(node, "dup");
    dup.hidden = !r.duplicate_of;
    if (r.duplicate_of) dup.title = "Same phone as referral " + r.duplicate_of + "; not sent to Rotor again.";
    const notDelivered = Boolean(r.rotor) && r.rotor.delivered === false;
    const crm = hook(node, "crm");
    crm.hidden = !notDelivered;
    if (notDelivered) {
      crm.title = r.duplicate_of ? "Duplicates aren't sent to Rotor." :
        "Rotor didn't accept this lead" + (r.rotor.status ? " (HTTP " + r.rotor.status + ")" : "") + ". Add it by hand.";
    }
    setTime(hook(node, "created"), r.created_at);

    const tel = telHref(r.phone);
    setLink(node, "phone", fmtPhone(r.phone) || "No phone", tel);
    if (r.email) { hook(node, "email-row").hidden = false; setLink(node, "email", r.email, "mailto:" + r.email); }
    if (r.address) { hook(node, "address-row").hidden = false; setText(node, "address", r.address); }
    if (r.quote_requested_at) { hook(node, "quoted-row").hidden = false; setTime(hook(node, "quoted"), r.quote_requested_at); }
    // The most recent history entry, once there is more than the automatic
    // "received" one: who moved it, when, and their note.
    const history = Array.isArray(r.history) ? r.history : [];
    const last = history.length > 1 ? history[history.length - 1] : null;
    if (last) {
      hook(node, "last-row").hidden = false;
      const by = last.by === "office" ? "by the office" : last.by === "lead-form" ? "from the quote form" : "";
      setText(node, "last", [statusLabel(last.status), relTime(last.at), by, last.note].filter(Boolean).join(" · "));
    }

    const names = referrerNames(r);
    setText(node, "ref-name", r.referrer_name || fullName(names[0], names[1]) || "Unknown referrer");
    setLink(node, "ref-phone", fmtPhone(r.referrer_phone), telHref(r.referrer_phone));
    setText(node, "code", r.code || "");
    if (r.note) { hook(node, "note-row").hidden = false; setText(node, "note", r.note); }
    if (r.reward && r.status === "rewarded") {
      hook(node, "reward").hidden = false;
      setText(node, "reward-text", "Reward issued: " + rewardLabel(r.reward.type, r.reward.amount)
        + (r.reward.issued_at ? " · " + fmtDate(r.reward.issued_at) : "")
        + (r.reward.note ? " · " + r.reward.note : ""));
    }

    // One-tap links. Hidden rather than dead when there's no usable number.
    const smsFriend = hook(node, "sms-friend"), hf = smsHref(r.phone, friendText(r));
    if (hf) smsFriend.href = hf; else smsFriend.hidden = true;
    const call = hook(node, "call-friend");
    if (tel) call.href = tel; else call.hidden = true;
    const smsRef = hook(node, "sms-ref"), hr = smsHref(r.referrer_phone, referrerText(r));
    if (hr) smsRef.href = hr; else smsRef.hidden = true;

    // Status <select>. The visible label stays "Status"; the accessible
    // name adds the friend so a form-controls list isn't N × "Status".
    const sel = hook(node, "status-select");
    sel.id = uid + "-status";
    hook(node, "status-label").htmlFor = sel.id;
    sel.setAttribute("aria-label", "Status for " + name);
    sel.value = STATUSES.includes(r.status) ? r.status : "";
    sel.addEventListener("change", () => onStatusChange(r, node, sel));

    // Issue reward: radio defaults to what the referrer asked for.
    const issueBtn = hook(node, "issue"), panel = hook(node, "issue-panel");
    const radios = $$('input[type="radio"]', panel);
    radios.forEach((inp) => { inp.name = uid + "-reward"; });
    const noteIn = hook(node, "issue-note");
    noteIn.id = uid + "-issue-note";
    hook(node, "issue-note-label").htmlFor = noteIn.id;
    panel.id = uid + "-issue";
    issueBtn.setAttribute("aria-controls", panel.id);
    issueBtn.setAttribute("aria-expanded", "false");
    // A rewarded referral can't be rewarded again (the API says 409); to
    // re-issue, the office moves it back to Booked first.
    if (r.status === "rewarded") issueBtn.hidden = true;
    const openPanel = (focusFirst) => {
      openIssue = id;
      panel.hidden = false;
      issueBtn.setAttribute("aria-expanded", "true");
      if (!radios.some((x) => x.checked)) {
        const p = referrerOf(r), pref = p && p.reward_pref === "giftcard" ? "giftcard" : "credit";
        radios.forEach((x) => { x.checked = x.value === pref; });
      }
      if (focusFirst) (radios.find((x) => x.checked) || radios[0]).focus();
    };
    const closePanel = () => {
      if (openIssue === id) openIssue = null;
      panel.hidden = true;
      issueBtn.setAttribute("aria-expanded", "false");
      noteIn.value = "";
      radios.forEach((x) => { x.checked = false; });
    };
    issueBtn.addEventListener("click", () => {
      if (panel.hidden) openPanel(true); else { closePanel(); issueBtn.focus(); }
    });
    hook(node, "issue-cancel").addEventListener("click", () => { closePanel(); issueBtn.focus(); });
    hook(node, "issue-confirm").addEventListener("click", () => {
      const chosen = radios.find((x) => x.checked);
      if (!chosen) { radios[0].focus(); toast("Pick credit or gift card first.", true); return; }
      act({ action: "issue_reward", id, reward_type: chosen.value, note: noteIn.value.trim() }, node).then((data) => {
        if (!data) return;
        openIssue = null;
        applyReferral(data.referral);
        render();
        const rw = (data.referral && data.referral.reward) || { type: chosen.value };
        toast("Reward issued: " + rewardLabel(rw.type, rw.amount) + " for " + (r.referrer_name || "the referrer") + ".");
        // Texting the referrer is the natural next step.
        focusIn(listEl, id, "sms-ref");
      });
    });
    if (openIssue === id) openPanel(false);

    // Office note. Unsaved text survives re-renders (a timed refresh, a
    // status change elsewhere) via dirtyNotes.
    const ta = hook(node, "office-note");
    ta.id = uid + "-note";
    hook(node, "office-note-label").htmlFor = ta.id;
    const saveBtn = hook(node, "save-note"), noteState = hook(node, "note-state");
    const saved = r.office_note || "";
    ta.value = dirtyNotes.has(id) ? dirtyNotes.get(id) : saved;
    const syncNote = () => {
      const dirty = ta.value !== saved;
      if (dirty) dirtyNotes.set(id, ta.value); else dirtyNotes.delete(id);
      saveBtn.disabled = !dirty;
      noteState.textContent = dirty ? "Unsaved changes" : "";
      noteState.classList.toggle("is-dirty", dirty);
    };
    syncNote();
    ta.addEventListener("input", syncNote);
    saveBtn.addEventListener("click", () => {
      act({ action: "set_note", id, note: ta.value.trim() }, node).then((data) => {
        if (!data) return;
        dirtyNotes.delete(id);
        applyReferral(data.referral);
        render();
        toast("Note saved.");
        focusIn(listEl, id, "office-note");
      });
    });

    hook(node, "delete").addEventListener("click", (e) => {
      const text = "Delete the referral for " + name + " (referred by " + (r.referrer_name || "unknown")
        + ")? It disappears from this dashboard and from the referrer's tracking page. This can't be undone.";
      confirmDelete(text, e.currentTarget, () => {
        act({ action: "delete", id }, node).then((data) => {
          if (!data) return;
          removeReferral(id);
          render();
          toast("Referral for " + name + " deleted.");
          resultsEl.focus();
        });
      });
    });
    return node;
  };

  const renderList = () => {
    const rows = visibleReferrals();
    const memo = rememberFocus(listEl);
    const frag = document.createDocumentFragment();
    rows.forEach((r) => frag.appendChild(buildCard(r)));
    listEl.replaceChildren(frag);
    emptyEl.hidden = rows.length > 0;
    emptyEl.textContent = state.data.referrals.length
      ? "No referrals match this filter."
      : "No referrals yet. They'll show up here as customers send them from refer.html.";
    restoreFocus(listEl, memo);
  };

  const buildRow = (p) => {
    const tr = tplRow.content.firstElementChild.cloneNode(true);
    tr.dataset.id = String(p.id);
    const name = fullName(p.first_name, p.last_name) || "Unnamed customer";
    setText(tr, "name", name);
    setText(tr, "email", p.email || "");
    setLink(tr, "phone", fmtPhone(p.phone) || "No phone", telHref(p.phone));
    setText(tr, "code", p.code || "");
    const sel = hook(tr, "pref"), label = hook(tr, "pref-label");
    sel.id = "ra-ref-" + String(p.id).replace(/[^a-z0-9_-]/gi, "") + "-pref";
    label.htmlFor = sel.id;
    label.textContent = "Reward preference for " + name;
    sel.value = p.reward_pref === "giftcard" ? "giftcard" : "credit";
    sel.addEventListener("change", () => {
      const prev = p.reward_pref === "giftcard" ? "giftcard" : "credit";
      act({ action: "set_reward_pref", referrer_id: p.id, reward_pref: sel.value }, tr).then((data) => {
        if (!data) { sel.value = prev; return; }
        applyReferrer(data.referrer);
        render();
        toast(name + " now prefers " + prefLabel(data.referrer && data.referrer.reward_pref) + ".");
        focusIn(referrersBody, p.id, "pref");
      });
    });
    setText(tr, "referred", String(p.referred || 0));
    setText(tr, "booked", String(p.booked || 0));
    setText(tr, "rewarded", String(p.rewarded || 0));
    const when = hook(tr, "created");
    when.textContent = fmtDate(p.created_at);
    when.title = fmtExact(p.created_at);
    when.dateTime = p.created_at || "";
    return tr;
  };

  const renderReferrers = () => {
    const rows = visibleReferrers();
    const memo = rememberFocus(referrersBody);
    const frag = document.createDocumentFragment();
    rows.forEach((p) => frag.appendChild(buildRow(p)));
    referrersBody.replaceChildren(frag);
    tableWrap.hidden = rows.length === 0;
    referrersEmpty.hidden = rows.length > 0;
    referrersEmpty.textContent = state.data.referrers.length ? "No referrers match." : "No referrers yet.";
    restoreFocus(referrersBody, memo);
  };

  const render = () => {
    if (!state.data) return;
    renderStats();
    renderList();
    renderReferrers();
    renderMeta();
  };

  /* ---- View tabs (Referrals | Referrers), arrow-key operable ---- */
  const setView = (view, focusTab) => {
    state.view = view;
    tabs.forEach((t) => {
      const on = t.dataset.view === view;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      if (on && focusTab) t.focus();
    });
    panelReferrals.hidden = view !== "referrals";
    panelReferrers.hidden = view !== "referrers";
    // The status chips filter referrals only.
    filters.hidden = view !== "referrals";
    if (state.data) renderMeta();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => setView(t.dataset.view, false));
    t.addEventListener("keydown", (e) => {
      let to = -1;
      if (e.key === "ArrowRight") to = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") to = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = tabs.length - 1;
      if (to < 0) return;
      e.preventDefault();
      setView(tabs[to].dataset.view, true);
    });
  });

  /* ---- Status chips ---- */
  chips.forEach((c) => c.addEventListener("click", () => {
    state.filter = c.dataset.filter;
    chips.forEach((x) => x.setAttribute("aria-pressed", x === c ? "true" : "false"));
    if (state.data) { renderList(); renderMeta(); }
  }));

  /* ---- Search: client-side over the loaded list, debounced ---- */
  let searchTimer;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = searchInput.value;
      if (state.data) { renderList(); renderReferrers(); renderMeta(); }
    }, 150);
  });

  /* ---- Header tools ---- */
  refreshBtn.addEventListener("click", () => { load().then((ok) => { if (ok) toast("Refreshed."); }); });
  signoutBtn.addEventListener("click", () => signOut("You're signed out. Enter the key to open the dashboard again.", true));

  const localDate = () => {
    const d = new Date(), pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  };
  /* The export needs the auth header, so it can't be a plain link: fetch
     the CSV, hand it to the browser as an object URL, click a download
     link, then release the URL once the download has had time to start. */
  exportBtn.addEventListener("click", () => {
    exportBtn.disabled = true;
    exportBtn.setAttribute("aria-busy", "true");
    fetch(cfg.api + "?format=csv", { headers: { Authorization: "Bearer " + state.key, Accept: "text/csv" } })
      .then((res) => {
        if (res.status === 401) { signOut(SIGNED_OUT); return null; }
        if (!res.ok) return res.json().catch(() => null).then((data) => { throw fail(describe(res, data)); });
        return res.blob();
      })
      .then((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "referrals-" + localDate() + ".csv";
        a.hidden = true;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast("Downloaded " + a.download + ".");
      })
      .catch((err) => {
        if (!(err && err.user)) console.error(err);
        toast(err && err.user ? err.message : describe(null), true);
      })
      .finally(() => {
        exportBtn.disabled = false;
        exportBtn.setAttribute("aria-busy", "false");
      });
  });

  /* ---- Key screen ---- */
  keyForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = keyInput.value.trim();
    if (!v) { setErr("Enter the admin key to continue."); keyInput.focus(); return; }
    state.key = v;
    keySubmit.disabled = true;
    keySubmit.textContent = "Checking…";
    load().finally(() => { keySubmit.disabled = false; keySubmit.textContent = "Continue"; });
  });
  keyToggle.addEventListener("click", () => {
    const show = keyInput.type === "password";
    keyInput.type = show ? "text" : "password";
    keyToggle.setAttribute("aria-pressed", show ? "true" : "false");
    keyToggle.setAttribute("aria-label", show ? "Hide key" : "Show key");
    keyInput.focus();
  });

  /* ---- Delete confirmation ----
     Native <dialog> for the focus trap, Escape and backdrop; Cancel takes
     focus first so Enter can't delete by accident. Focus returns to the
     button that opened it (if that card still exists). */
  const confirmText = $("#ra-confirm-text"), confirmOk = $("#ra-confirm-ok"), confirmCancel = $("#ra-confirm-cancel");
  let pendingDelete = null, returnFocus = null;
  const confirmDelete = (text, opener, onOk) => {
    if (!dialog || typeof dialog.showModal !== "function") { if (window.confirm(text)) onOk(); return; }
    confirmText.textContent = text;
    pendingDelete = onOk;
    returnFocus = opener;
    dialog.showModal();
    confirmCancel.focus();
  };
  if (dialog) {
    confirmCancel.addEventListener("click", () => dialog.close());
    confirmOk.addEventListener("click", () => {
      const fn = pendingDelete;
      pendingDelete = null;
      dialog.close();
      if (fn) fn();
    });
    dialog.addEventListener("close", () => {
      pendingDelete = null;
      if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
      returnFocus = null;
    });
  }

  /* ---- Timed refresh ----
     Once a minute while the tab is visible, but never while the office is
     mid-edit: a select open in a card, a note being typed, an Issue-reward
     panel or the delete dialog would all be wiped by a re-render. Coming
     back to a tab that has been hidden longer than the interval refreshes
     straight away. */
  const editing = () => {
    const a = document.activeElement;
    if (openIssue || (dialog && dialog.open)) return true;
    return Boolean(a && (listEl.contains(a) || referrersBody.contains(a)) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  };
  setInterval(() => {
    if (!state.authed || document.hidden) return;
    if (loading || editing()) { renderMeta(); return; }
    load({ silent: true });
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.authed && !loading && Date.now() - state.loadedAt > REFRESH_MS && !editing())
      load({ silent: true });
  });

  /* ---- Boot ---- */
  const remembered = storage.get();
  if (remembered) {
    state.key = remembered;
    keySubmit.disabled = true;
    keySubmit.textContent = "Signing in…";
    load().finally(() => { keySubmit.disabled = false; keySubmit.textContent = "Continue"; });
  } else {
    showKey("");
  }
})();
