/* =====================================================================
   Barta Window Washing — Referral app (index.html + friend.html)
   Vanilla JS, no dependencies. Progressive enhancement: both pages render
   their full generic copy without this file. It adds the referral form
   submission and success screen, the referrer's private dashboard
   (?t=TOKEN), and on friend.html the personalisation from the code plus
   the claim form. Request/response shapes: README.md.
   ===================================================================== */
(function () {
  "use strict";
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scrollTo = (el, block) => el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: block || "center" });
  const API = "/api/referral";
  const params = new URLSearchParams(location.search);

  /* The offer comes from <main>'s data attributes (sitedata.REFERRAL via
     build/pages.py) so every dollar figure this script prints
     matches the page copy, and nothing here needs editing when the amounts
     change. */
  const main = $("main[data-friend-off]");
  if (!main) return;
  const cfg = {
    friendOff: Number(main.dataset.friendOff),
    credit: Number(main.dataset.credit),
    gift: Number(main.dataset.gift),
    prefix: main.dataset.prefix || "",
    maxFriends: Number(main.dataset.maxFriends) || 10,
    phone: main.dataset.phone || "",
    email: main.dataset.email || "",
  };
  const money = (n) => "$" + n;
  // Same rule as main.js' data-validate-phone: 10 US digits, leading 1 dropped.
  const digits = (v) => String(v || "").replace(/\D/g, "").replace(/^1/, "");
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const trim = (el) => (el ? el.value.trim() : "");

  /* Inline field errors, shared by the referral form and the friend page's
     claim form: a message under the field, aria-invalid/aria-describedby on
     the input, and the field marked so the CSS can outline it. */
  const setError = (input, msg) => {
    const field = input.closest(".field");
    if (!field) return;
    let err = field.querySelector(".ref-err");
    if (msg) {
      if (!err) {
        err = document.createElement("p");
        err.className = "ref-err";
        err.id = input.id + "-err";
        field.appendChild(err);
      }
      err.textContent = msg;
      field.classList.add("is-invalid");
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", err.id);
    } else if (err) {
      err.remove();
      field.classList.remove("is-invalid");
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    }
  };

  /* fetch that always resolves to { res, data } so callers can branch on
     status and body together; a non-JSON body (a host 404 page, a proxy
     error) just leaves data null instead of throwing inside the chain. */
  const api = (url, options) =>
    fetch(url, options).then((res) => res.json().catch(() => null).then((data) => ({ res, data })));

  /* One-tap share messages. The friend text names the referrer, the offer,
     and the share link, so it reads like the office's own template. */
  const shareLinks = (first, shareUrl) => {
    const who = first ? first + " referred you" : "A friend referred you";
    const msg = "Hi! " + who + " to Barta Window Washing, so your first service is " + money(cfg.friendOff)
      + " off. Claim it here: " + shareUrl;
    const subject = money(cfg.friendOff) + " off Barta Window Washing" + (first ? ", from " + first : "");
    return {
      sms: "sms:?&body=" + encodeURIComponent(msg),
      mail: "mailto:?subject=" + encodeURIComponent(subject)
        + "&body=" + encodeURIComponent(msg + "\n\nOr call " + cfg.phone + " and mention the code."),
    };
  };

  /* Copy button: async clipboard where allowed, select + execCommand where
     not (older Safari, non-secure contexts), and a spoken "Copied!" either
     way. If both fail the text is left selected so a manual copy is one
     keystroke away. */
  const bindCopy = (btn, input, status) => {
    if (!btn || !input) return;
    const label = btn.innerHTML;
    let timer;
    const done = (ok) => {
      btn.textContent = ok ? "Copied!" : "Copy";
      if (status) status.textContent = ok ? "Copied!" : "Couldn't copy automatically, the link is selected for you.";
      clearTimeout(timer);
      timer = setTimeout(() => { btn.innerHTML = label; if (status) status.textContent = ""; }, 2400);
    };
    const legacy = () => {
      try {
        input.focus();
        input.select();
        input.setSelectionRange(0, input.value.length);
        done(document.execCommand("copy"));
      } catch (e) { done(false); }
    };
    btn.addEventListener("click", () => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(input.value).then(() => done(true), legacy);
      } else legacy();
    });
  };

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  };

  /* Customer-facing names for the record statuses (the office sees the raw
     ones on its dashboard). Anything unexpected shows as "Sent". */
  const STATUS = {
    new: ["Sent", "sent"],
    contacted: ["Contacted", "contacted"],
    quoted: ["Quote requested", "quoted"],
    booked: ["Booked", "booked"],
    completed: ["Job complete", "done"],
    rewarded: ["Reward issued", "rewarded"],
    declined: ["Not this time", "declined"],
  };
  const rewardText = (rw) => {
    if (!rw) return "";
    const amount = rw.amount != null ? rw.amount : (rw.type === "giftcard" ? cfg.gift : cfg.credit);
    return money(amount) + (rw.type === "giftcard" ? " gift card" : " credit");
  };
  const prefLabel = (pref) => (pref === "giftcard" ? money(cfg.gift) + " gift card" : money(cfg.credit) + " credit");

  /* =================================================================
     index.html — the referral form, success screen and private dashboard
     ================================================================= */
  const form = $("#refer-form");
  if (form) {
    const card = form.parentElement;
    const alertBox = $("#ref-alert");
    const fallback = $(".form-fallback", card);
    const success = $("#ref-success");
    const submitBtn = $("#ref-submit");
    const list = $("#ref-friends");
    const tpl = $("#ref-friend-tpl");
    const addBtn = $("#ref-add-friend");
    const counter = $("#ref-friend-count");
    const tokenField = $("#ref-token");
    const heading = $("#ref-form-heading");
    const rewardErr = $("#ref-reward-err");
    const me = { first_name: $("#ref-first"), last_name: $("#ref-last"), phone: $("#ref-phone"), email: $("#ref-email") };
    let nextIndex = $$("[data-friend]", list).length + 1;
    // innerHTML, not textContent: the label carries an inline arrow icon
    // that has to survive the "Sending…" swap.
    const submitLabel = submitBtn.innerHTML;
    const setSending = (on) => {
      submitBtn.disabled = on;
      if (on) submitBtn.textContent = "Sending…"; else submitBtn.innerHTML = submitLabel;
    };

    /* ---- Inline validation (setError is shared with the claim form) ---- */
    // Errors clear the moment the field is touched again.
    form.addEventListener("input", (e) => { if (e.target.matches("input")) setError(e.target, ""); });
    form.addEventListener("change", (e) => {
      if (e.target.name === "reward_pref" && rewardErr) { rewardErr.hidden = true; rewardErr.textContent = ""; }
    });

    const rows = () => $$("[data-friend]", list);
    const fieldsOf = (row) => {
      const o = {};
      $$("[data-field]", row).forEach((el) => { o[el.dataset.field] = el; });
      return o;
    };

    const validate = () => {
      let first = null;
      const bad = (input, msg) => { setError(input, msg); if (!first) first = input; };
      const ok = (input) => setError(input, "");
      const checkEmail = (input) => {
        const v = trim(input);
        if (!v || EMAIL_RE.test(v)) ok(input); else bad(input, "That email doesn’t look right.");
      };

      if (trim(me.first_name)) ok(me.first_name); else bad(me.first_name, "Please enter your first name.");
      const mine = digits(me.phone.value);
      if (mine.length === 10) ok(me.phone); else bad(me.phone, "Please enter a valid 10-digit mobile number.");
      checkEmail(me.email);

      const seen = new Set();
      rows().forEach((row) => {
        const f = fieldsOf(row);
        if (trim(f.first_name)) ok(f.first_name); else bad(f.first_name, "Please enter your friend’s first name.");
        if (trim(f.last_name)) ok(f.last_name); else bad(f.last_name, "Please enter your friend’s last name.");
        const d = digits(f.phone.value);
        if (d.length !== 10) bad(f.phone, "Please enter a valid 10-digit mobile number.");
        else if (d === mine) bad(f.phone, "That’s your own number, so it can’t be referred.");
        else if (seen.has(d)) bad(f.phone, "You’ve already added this number above.");
        else { ok(f.phone); seen.add(d); }
      });

      // The reward is picked later, when a friend's job is complete; a form
      // that still offers the choice up front just has to have one picked.
      if (form.querySelector('input[name="reward_pref"]') && !form.querySelector('input[name="reward_pref"]:checked')) {
        if (rewardErr) { rewardErr.textContent = "Please choose your reward."; rewardErr.hidden = false; }
        if (!first) first = $("#ref-reward-credit");
      }
      const consent = $("#ref-consent");
      if (consent.checked) ok(consent); else bad(consent, "Please confirm you have your friends’ permission.");
      return first;
    };

    /* Server errors name the field as a dotted path (referrer.phone,
       friends.1.phone, consent); map it back to the input. */
    const fieldFor = (path) => {
      if (typeof path !== "string" || !path) return null;
      const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
      if (parts[0] === "referrer") {
        if (parts[1] === "reward_pref") return $("#ref-reward-credit") || me.first_name;
        return me[parts[1]] || me.first_name; // bare "referrer" lands on the first field
      }
      if (parts[0] === "friends") {
        const row = rows()[Number(parts[1])] || (parts.length === 1 ? rows()[0] : null);
        if (!row) return null;
        return $('[data-field="' + parts[2] + '"]', row) || $('[data-field="first_name"]', row);
      }
      if (parts[0] === "consent") return $("#ref-consent");
      return null;
    };

    /* ---- Friend rows: add / remove / cap ---- */
    const refreshRows = () => {
      const all = rows();
      all.forEach((row, i) => {
        const n = i + 1;
        $("[data-friend-num]", row).textContent = n;
        const rm = $("[data-remove-friend]", row);
        rm.setAttribute("aria-label", "Remove friend " + n);
        rm.hidden = all.length === 1; // never below one friend
      });
      const max = cfg.maxFriends;
      addBtn.disabled = all.length >= max;
      counter.textContent = all.length >= max
        ? max + " per submission. Send these, then refer more — there’s no limit."
        : all.length + " of " + max + " friends added";
    };
    const addRow = (focus) => {
      if (rows().length >= cfg.maxFriends) return null;
      const wrap = document.createElement("div");
      wrap.innerHTML = tpl.innerHTML.replace(/__N__/g, String(nextIndex++));
      const row = wrap.firstElementChild;
      list.appendChild(row);
      refreshRows();
      if (focus) $('[data-field="first_name"]', row).focus();
      return row;
    };
    list.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-remove-friend]");
      if (!btn) return;
      const all = rows();
      if (all.length === 1) return;
      const idx = all.indexOf(btn.closest("[data-friend]"));
      all[idx].remove();
      refreshRows();
      // Land on the row that took this one's place (or the last one left).
      const left = rows();
      const target = left[Math.min(idx, left.length - 1)];
      ($('[data-field="first_name"]', target) || addBtn).focus();
    });
    addBtn.addEventListener("click", () => addRow(true));
    refreshRows();

    /* ---- Messages ---- */
    const showAlert = (msg) => {
      alertBox.textContent = msg;
      alertBox.hidden = false;
      scrollTo(alertBox);
    };
    const hideAlert = () => { alertBox.hidden = true; alertBox.textContent = ""; };
    // Never claim a submission landed when it didn't: same fallback as the
    // quote forms, with everything typed still on screen.
    const showFallback = () => {
      if (!fallback) return;
      fallback.hidden = false;
      fallback.setAttribute("role", "alert");
      scrollTo(fallback);
    };

    /* ---- Success ---- */
    const joinNames = (names) => {
      if (names.length <= 1) return names[0] || "your friend";
      if (names.length === 2) return names[0] + " and " + names[1];
      return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
    };
    const showSuccess = (data, sent) => {
      const first = (data.referrer && data.referrer.first_name) || sent.referrer.first_name;
      const names = (Array.isArray(data.friends) && data.friends.length ? data.friends : sent.friends)
        .map((f) => f.first_name).filter(Boolean);
      const many = names.length > 1;
      $("#ref-success-title").textContent = "Thanks, " + first + "! Your referral" + (many ? "s are" : " is") + " on the way.";
      $("#ref-success-sub").textContent = "We’ll reach out to " + joinNames(names) + " with " + (many ? "their" : "the")
        + " " + money(cfg.friendOff) + " off. Once " + (many ? "one of them" : names[0] || "your friend") + " has had their first service, you pick a "
        + money(cfg.credit) + " credit or a " + money(cfg.gift) + " gift card.";
      $("#ref-code").textContent = data.code || "";
      const url = data.share_url || "";
      $("#ref-url").value = url;

      const trackWrap = $("#ref-track-wrap"), trackNone = $("#ref-track-none"), trackReturning = $("#ref-track-returning");
      trackReturning.hidden = true;
      // stored:false = the tracking store was unavailable; the referrals
      // still reached the office, but a status link would dead-end.
      if (data.stored !== false && data.status_url) {
        $("#ref-track").href = data.status_url;
        trackWrap.hidden = false;
        trackNone.hidden = true;
        if (data.token) tokenField.value = data.token;
      } else if (data.returning) {
        // Known customer, but this request didn't come from their tracking
        // link, so the server kept the private link private.
        trackWrap.hidden = true;
        trackNone.hidden = true;
        trackReturning.hidden = false;
      } else {
        trackWrap.hidden = true;
        trackNone.hidden = false;
      }
      form.classList.add("sent");
      if (fallback) fallback.hidden = true;
      success.classList.add("show");
      success.setAttribute("role", "status");
      const title = $("#ref-success-title");
      title.focus({ preventScroll: true });
      scrollTo(success, "start");
      // A dashboard on screen is now out of date; refresh it quietly.
      if (tokenField.value && !$("#ref-dash").hidden) loadDashboard(tokenField.value, true);
    };

    // Back to a blank friend list with the referrer's own details kept.
    $("#ref-more").addEventListener("click", () => {
      rows().slice(1).forEach((r) => r.remove());
      const firstRow = rows()[0];
      $$("input", firstRow).forEach((i) => { i.value = ""; setError(i, ""); });
      const consent = $("#ref-consent");
      consent.checked = false;
      setError(consent, "");
      refreshRows();
      success.classList.remove("show");
      success.removeAttribute("role");
      form.classList.remove("sent");
      hideAlert();
      setSending(false); // the button was left on "Sending…" when the form hid
      heading.textContent = "Refer more friends";
      const firstInput = $('[data-field="first_name"]', firstRow);
      firstInput.focus({ preventScroll: true });
      scrollTo(form, "start");
    });

    /* ---- Submit ---- */
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      hideAlert();
      const firstBad = validate();
      if (firstBad) {
        showAlert("Please check the highlighted fields.");
        firstBad.focus({ preventScroll: true });
        scrollTo(firstBad);
        return;
      }
      const reward = form.querySelector('input[name="reward_pref"]:checked');
      const body = {
        referrer: {
          first_name: trim(me.first_name), last_name: trim(me.last_name),
          phone: trim(me.phone), email: trim(me.email), reward_pref: reward ? reward.value : "",
        },
        // Name and mobile only: the office texts them a link to their own
        // form, which is where an email, address and notes get collected.
        friends: rows().map((row) => {
          const f = fieldsOf(row);
          return {
            first_name: trim(f.first_name), last_name: trim(f.last_name), phone: trim(f.phone),
          };
        }),
        consent: true,
        page: location.pathname,
      };
      if (tokenField.value) body.token = tokenField.value;

      setSending(true);
      const restore = () => setSending(false);

      api(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      })
        .then(({ res, data }) => {
          if (res.ok && data && data.ok) { showSuccess(data, body); return; }
          if (res.status >= 400 && res.status < 500 && data && data.error) {
            // The server's own words, at the top and on the field it named.
            restore();
            showAlert(data.error);
            const el = fieldFor(data.field);
            if (el) {
              setError(el, data.error);
              el.focus({ preventScroll: true });
            } else {
              alertBox.focus({ preventScroll: true });
            }
            return;
          }
          throw new Error("HTTP " + res.status);
        })
        .catch(() => { restore(); showFallback(); });
    });

    /* ---- Private dashboard (?t=TOKEN) ---- */
    const dash = $("#ref-dash");
    const statusLine = $("#ref-status");
    const note = (cls, text) => {
      statusLine.className = "ref-note" + (cls ? " " + cls : "");
      statusLine.textContent = text;
      statusLine.hidden = false;
    };

    // The token of the dashboard on screen; the reward pick posts with it.
    let dashToken = "";
    const choiceTpl = $("#ref-choice-tpl");

    /* A friend whose first job is complete: the referrer picks credit or a
       gift card right in the list. The pick posts to the API and the row
       re-renders from the server's answer, so what shows is what's stored. */
    const choiceBlock = (x, li) => {
      if (!choiceTpl) return null;
      const box = choiceTpl.content.firstElementChild.cloneNode(true);
      const title = $("[data-choice-title]", box);
      if (title) title.textContent = (x.friend_name || "Your friend") + "’s first service is complete: pick your reward.";
      const err = $("[data-choice-err]", box);
      $$("[data-choice]", box).forEach((btn) => btn.addEventListener("click", () => {
        $$("[data-choice]", box).forEach((b) => { b.disabled = true; });
        if (err) err.hidden = true;
        api(API, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ action: "choose_reward", t: dashToken, id: x.id, reward_type: btn.dataset.choice }),
        }).then(({ res, data }) => {
          if (res.ok && data && data.ok && data.referral) {
            const fresh = referralItem(data.referral);
            li.replaceWith(fresh);
            const done = $(".ref-item-meta", fresh);
            if (done) { done.setAttribute("tabindex", "-1"); done.focus({ preventScroll: true }); }
            return;
          }
          throw new Error((data && data.error) || "HTTP " + res.status);
        }).catch((e) => {
          $$("[data-choice]", box).forEach((b) => { b.disabled = false; });
          if (err) { err.textContent = (e && e.message && !/^HTTP/.test(e.message)) ? e.message : "That didn’t go through. Please try again, or call us."; err.hidden = false; }
        });
      }));
      return box;
    };

    const referralItem = (x) => {
      const li = document.createElement("li");
      li.className = "ref-item";
      const st = STATUS[x.status] || STATUS.new;
      const name = document.createElement("span");
      name.className = "ref-item-name";
      name.textContent = x.friend_name || "Your friend";
      const meta = document.createElement("span");
      meta.className = "ref-item-meta";
      const when = fmtDate(x.created_at);
      const picked = x.reward && x.reward.type;
      if (x.status === "rewarded" && x.reward) {
        meta.textContent = rewardText(x.reward) + (fmtDate(x.reward.issued_at) ? ", issued " + fmtDate(x.reward.issued_at) : "");
      } else if (x.status === "completed" && picked) {
        meta.textContent = "You picked the " + prefLabel(x.reward.type) + ". We’re getting it to you now.";
      } else if (x.status === "completed") {
        meta.textContent = "Job complete. Your reward is ready to pick.";
      } else {
        meta.textContent = when ? "Referred " + when : "";
      }
      const pill = document.createElement("span");
      pill.className = "ref-pill ref-pill--" + st[1];
      pill.textContent = st[0];
      li.append(name, meta, pill);
      if (x.status === "completed" && !picked) {
        const box = choiceBlock(x, li);
        if (box) li.appendChild(box);
      }
      return li;
    };

    const renderDashboard = (data, tok, quiet) => {
      const r = data.referrer || {};
      const t = data.totals || {};
      $("#ref-dash-name").textContent = r.first_name || "";
      $("#ref-stat-referred").textContent = t.referred || 0;
      $("#ref-stat-booked").textContent = t.booked || 0;
      $("#ref-stat-pending").textContent = t.pending || 0;
      const credit = Number(t.credit_earned) || 0;
      const cards = Number(t.gift_cards_earned) || 0;
      $("#ref-stat-rewards").textContent = money(credit + cards * cfg.gift);
      $("#ref-stat-rewards-detail").textContent = credit && cards
        ? money(credit) + " credit + " + cards + (cards === 1 ? " gift card" : " gift cards")
        : cards ? cards + (cards === 1 ? " gift card" : " gift cards") : credit ? "account credit" : "";

      $("#ref-dash-code").textContent = r.code || "";
      $("#ref-dash-url").value = data.share_url || "";
      const links = shareLinks(r.first_name, data.share_url || "");
      $("#ref-dash-sms").href = links.sms;
      $("#ref-dash-email").href = links.mail;

      const ul = $("#ref-dash-list");
      ul.innerHTML = "";
      (Array.isArray(data.referrals) ? data.referrals : []).forEach((x) => ul.appendChild(referralItem(x)));
      $("#ref-dash-empty").hidden = ul.children.length > 0;

      // The referrer is known: fill their details in and lock them (still
      // submitted), carry the token, and retitle the form.
      Object.keys(me).forEach((k) => {
        me[k].value = r[k] || "";
        me[k].readOnly = true;
        me[k].classList.add("ref-locked");
        setError(me[k], "");
      });
      $("#ref-locked-note").hidden = false;
      if (r.reward_pref) {
        const radio = form.querySelector('input[name="reward_pref"][value="' + r.reward_pref + '"]');
        if (radio) radio.checked = true;
      }
      tokenField.value = tok;
      dashToken = tok;
      heading.textContent = "Refer more friends";
      dash.hidden = false;
      statusLine.hidden = true;
      if (!quiet) scrollTo(dash, "start");
    };

    function loadDashboard(tok, quiet) {
      if (!quiet) note("", "Loading your referrals…");
      api(API + "?t=" + encodeURIComponent(tok), { headers: { Accept: "application/json" } })
        .then(({ res, data }) => {
          if (res.ok && data && data.ok) { renderDashboard(data, tok, quiet); return; }
          if (res.status === 404) {
            if (!quiet) note("ref-note--warn", "We couldn’t find that tracking link. It may have been copied incompletely. You can still refer friends below, and we’ll send you a fresh link.");
            return;
          }
          throw new Error("HTTP " + res.status);
        })
        .catch(() => {
          if (!quiet) note("ref-note--warn", "We couldn’t load your referrals right now. Please try again in a minute, or call us at " + cfg.phone + ".");
        });
    }

    bindCopy($("#ref-copy"), $("#ref-url"), $("#ref-copy-status"));
    bindCopy($("#ref-dash-copy"), $("#ref-dash-url"), $("#ref-dash-copy-status"));

    const token = (params.get("t") || "").trim();
    if (token) loadDashboard(token, false);
  }

  /* =================================================================
     friend.html — the friend landing (/r/CODE): personalise from the code,
     then take the claim right here
     ================================================================= */
  const landingTitle = $("#rd-title");
  if (landingTitle) {
    const lead = $("#rd-lead");
    const codeWrap = $("#rd-code-wrap");
    const codeEl = $("#rd-code");
    const codeField = $("#claim-code");
    const codeMentions = $$("[data-claim-code]");
    let referrerFirst = "";
    const showCode = (c) => {
      codeEl.textContent = c;
      codeWrap.hidden = !c;
      if (codeField) codeField.value = c;
      codeMentions.forEach((el) => {
        el.textContent = c;
        const wrap = el.closest("[data-claim-code-wrap]");
        if (wrap) wrap.hidden = !c;
      });
    };

    // Netlify serves the short link /r/CODE as a server-side rewrite of this
    // page, so the address bar keeps the short path and location.search is
    // empty there; the code then has to come off the path itself.
    const pathCode = (location.pathname.match(/\/r\/([A-Za-z0-9-]+)\/?$/) || [])[1] || "";
    let code = (params.get("code") || params.get("ref") || pathCode || "").trim().toUpperCase();
    // Lookups are case-insensitive; anything that isn't shaped like a code
    // gets the generic page rather than a request.
    if (code && /^[A-Z0-9][A-Z0-9-]{2,30}$/.test(code)) {
      showCode(code);
      api(API + "?code=" + encodeURIComponent(code), { headers: { Accept: "application/json" } })
        .then(({ res, data }) => {
          if (res.ok && data && data.ok) {
            referrerFirst = data.referrer_first_name || "";
            const off = Number(data.friend_discount) || cfg.friendOff;
            if (referrerFirst) {
              landingTitle.textContent = referrerFirst + " sent you " + money(off) + " off";
              lead.textContent = referrerFirst + " thinks you’ll love how we treat a home, and we’d love to prove it. "
                + "Your first service with " + (main.dataset.biz || "Barta Window Washing") + " is " + money(off) + " off, no strings attached.";
            }
            if (data.code) showCode(data.code);
          } else if (res.status === 404) {
            // Unknown code: the generic page. The typed code still travels
            // with the claim so the office can sort it out.
            codeWrap.hidden = true;
          }
          // Any other failure (no functions, network): the code from the
          // link stays on screen and goes with the claim as typed.
        })
        .catch(() => {});
    } else {
      code = "";
    }

    /* ---- The claim form ---- */
    const claim = $("#claim-form");
    if (claim) {
      const card = claim.parentElement;
      const alertBox = $("#claim-alert");
      const fallback = $(".form-fallback", card);
      const success = $("#claim-success");
      const submitBtn = $("#claim-submit");
      const f = {
        first_name: $("#claim-first"), last_name: $("#claim-last"), phone: $("#claim-phone"),
        email: $("#claim-email"), address: $("#claim-address"), note: $("#claim-note"),
      };
      const consent = $("#claim-consent");
      const submitLabel = submitBtn.innerHTML;
      const setSending = (on) => {
        submitBtn.disabled = on;
        if (on) submitBtn.textContent = "Sending…"; else submitBtn.innerHTML = submitLabel;
      };
      claim.addEventListener("input", (e) => { if (e.target.matches("input")) setError(e.target, ""); });

      const validate = () => {
        let first = null;
        const bad = (input, msg) => { setError(input, msg); if (!first) first = input; };
        const ok = (input) => setError(input, "");
        if (trim(f.first_name)) ok(f.first_name); else bad(f.first_name, "Please enter your first name.");
        if (digits(f.phone.value).length === 10) ok(f.phone); else bad(f.phone, "Please enter a valid 10-digit mobile number.");
        const em = trim(f.email);
        if (!em || EMAIL_RE.test(em)) ok(f.email); else bad(f.email, "That email doesn’t look right.");
        if (consent.checked) ok(consent); else bad(consent, "Please agree so we can call or text you about your request.");
        return first;
      };
      const showAlert = (msg) => { alertBox.textContent = msg; alertBox.hidden = false; scrollTo(alertBox); };
      const hideAlert = () => { alertBox.hidden = true; alertBox.textContent = ""; };
      const showFallback = () => {
        if (!fallback) return;
        fallback.hidden = false;
        fallback.setAttribute("role", "alert");
        scrollTo(fallback);
      };
      // Server errors name the field; map it back to the input.
      const fieldFor = (path) => {
        if (typeof path !== "string" || !path) return null;
        if (path === "consent") return consent;
        return f[path.split(".").pop()] || null;
      };

      claim.addEventListener("submit", (e) => {
        e.preventDefault();
        hideAlert();
        const firstBad = validate();
        if (firstBad) {
          showAlert("Please check the highlighted fields.");
          firstBad.focus({ preventScroll: true });
          scrollTo(firstBad);
          return;
        }
        const body = {
          code: (codeField && codeField.value) || code || "",
          first_name: trim(f.first_name), last_name: trim(f.last_name), phone: trim(f.phone),
          email: trim(f.email), address: trim(f.address), note: trim(f.note),
          services: $$('input[name="services"]:checked', claim).map((c) => c.value),
          consent: true,
          page: location.pathname,
        };
        setSending(true);
        api("/api/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
        })
          .then(({ res, data }) => {
            if (res.ok && data && data.ok) {
              const who = data.referrer_first_name || referrerFirst;
              $("#claim-success-title").textContent = "You’re all set, " + body.first_name + "!";
              $("#claim-success-sub").textContent = "We’ll call or text you shortly to set up your first service, with "
                + (who ? who + "’s " : "your ") + money(cfg.friendOff) + " off already applied.";
              showCode(data.code || body.code || "");
              claim.classList.add("sent");
              if (fallback) fallback.hidden = true;
              success.classList.add("show");
              success.setAttribute("role", "status");
              const title = $("#claim-success-title");
              title.focus({ preventScroll: true });
              scrollTo(success, "start");
              return;
            }
            if (res.status >= 400 && res.status < 500 && data && data.error) {
              setSending(false);
              showAlert(data.error);
              const el = fieldFor(data.field);
              if (el) {
                setError(el, data.error);
                el.focus({ preventScroll: true });
              } else {
                alertBox.focus({ preventScroll: true });
              }
              return;
            }
            throw new Error("HTTP " + res.status);
          })
          .catch(() => { setSending(false); showFallback(); });
      });
    }
  }
})();
