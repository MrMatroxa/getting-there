(() => {
  "use strict";

  const C = window.CONFIG;
  const I = window.I18N;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  // ---------- small helpers ----------
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------- language ----------
  // Saved choice, else the config default, else the phone's language.
  let lang = store.get("gt.lang", "");
  if (!I[lang]) lang = I[C.defaultLanguage] ? C.defaultLanguage : /^lv\b/i.test(navigator.language || "") ? "lv" : "en";

  function t(key, ...args) {
    const v = I[lang][key] ?? I.en[key];
    return typeof v === "function" ? v(...args) : v;
  }
  // Event wording from config.js, with an optional Latvian override in CONFIG.lv.
  const ct = (key) => (C[lang] && C[lang][key]) || C[key] || "";

  const AREAS = C.areas || ["Centrs", "Vecrīga", "Skanste", "Teika", "Purvciems", "Pļavnieki", "Āgenskalns", "Imanta"];
  const legs = C.legs;
  const legById = Object.fromEntries(legs.map((l) => [l.id, l]));

  const legDate = (leg) => {
    if (!leg.date) return null;
    const d = new Date(leg.date + "T12:00:00");
    return isNaN(d) ? null : d;
  };
  function fmtDate(leg) {
    const d = legDate(leg);
    return d ? d.toLocaleDateString(lang === "lv" ? "lv" : "en-GB", { day: "numeric", month: "short" }) : "";
  }
  function dayName(leg, short = false) {
    const d = legDate(leg);
    const table = I.days[lang];
    if (d && table) return table[short ? "short" : "long"][d.getDay()];
    return short ? leg.day.slice(0, 3) : leg.day;
  }
  const dayShort = (leg) => dayName(leg, true);
  const legDay = (leg, short = false) => {
    const date = fmtDate(leg);
    return dayName(leg, short) + (date ? " " + date : "");
  };
  const isBack = (leg) => !!leg && leg.direction === "from";
  const legDir = (leg) => (isBack(leg) ? t("backToCity") : t("toDest", ct("destination")));
  const legName = (leg) => `${legDay(leg, true)} · ${isBack(leg) ? t("back") : t("there")}`;

  // Free-text addresses open in Google Maps.
  function mapsUrl(place) {
    const q = [place, C.mapsCity].filter(Boolean).join(", ");
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
  }
  const placeLink = (place) =>
    `<a class="map-link" href="${esc(mapsUrl(place))}" target="_blank" rel="noopener" title="${esc(t("openInMaps"))}">${esc(place)}</a>`;

  // Time shown on a ride or request. Empty = nobody knows yet.
  const timeText = (x) => (x.time ? (x.flexible ? "~" + x.time : x.time) : t("tbd"));

  // The one place that matters on a card: where the driver meets people (way there)
  // or drops them off (way back). Everyone knows the other end.
  function placeHtml(trip) {
    return placeLink(trip.pickup);
  }

  // Where a person wants to meet or be dropped off: "Pļavnieki · Spice"
  function wantsHtml(r, leg) {
    const bits = [];
    if (r.area) bits.push(esc(r.area));
    if (r.pickup) bits.push(placeLink(r.pickup));
    if (!bits.length) return "";
    return `<span class="from">${isBack(leg) ? t("dropOff") : t("from")} ${bits.join(" · ")}</span>`;
  }
  const aroundHtml = (r) => (r.time ? `<span class="from">${esc(t("around", r.time))}</span>` : "");

  // Why someone is back on the list (their ride was cancelled, or the driver removed them).
  function relistText(r) {
    if (!r.relisted) return "";
    return r.relisted.why === "cancelled" ? t("relistCancelled", r.relisted.driver) : t("relistRemoved", r.relisted.driver);
  }
  function noteHtml(r, tag = "p") {
    const parts = [relistText(r), r.note].filter(Boolean);
    if (!parts.length) return "";
    return tag === "p" ? `<p class="note">${esc(parts.join(". "))}</p>` : `<span class="from">${esc(parts.join(". "))}</span>`;
  }

  // Turns what people type into a wa.me link when it looks like a phone number.
  function waNumber(contact) {
    const raw = String(contact || "").trim();
    if (!/^[+\d][\d\s\-().]*$/.test(raw)) return null;
    let d = raw.replace(/[^\d]/g, "");
    if (raw.startsWith("+")) {
      /* already international */
    } else if (d.startsWith("00")) {
      d = d.slice(2);
    } else if (C.defaultCountryCode && d.length <= 9) {
      d = C.defaultCountryCode + d.replace(/^0+/, "");
    }
    return d.length >= 8 && d.length <= 15 ? d : null;
  }
  function contactHtml(contact) {
    const n = waNumber(contact);
    const shown = `<span class="contact">${esc(contact)}</span>`;
    if (!n) return shown;
    return `<a class="wa" href="https://wa.me/${n}" target="_blank" rel="noopener">WhatsApp</a>${shown}`;
  }

  // ---------- state ----------
  let data = null;
  let mine = store.get("gt.mine", {}); // id -> token for things this phone created
  let me = store.get("gt.me", { name: "", contact: "" });
  let code = store.get("gt.code", "");
  let adminKey = store.get("gt.admin", "");
  let filter = store.get("gt.filter", "all"); // "all" or one leg id
  if (filter !== "all" && !legById[filter]) filter = "all";
  let lastLoaded = 0;

  const isMine = (id) => Object.prototype.hasOwnProperty.call(mine, id);
  function remember(id, token) {
    if (!id || !token) return;
    mine[id] = token;
    store.set("gt.mine", mine);
    render();
  }
  function rememberMe(name, contact) {
    me = { name, contact };
    store.set("gt.me", me);
  }

  // ---------- API ----------
  async function api(path, { method = "GET", body, token } = {}) {
    const headers = { "content-type": "application/json", "x-lang": lang };
    if (code) headers["x-event-code"] = code;
    if (adminKey) headers["x-admin-key"] = adminKey;
    if (token) headers["x-token"] = token;
    let res;
    try {
      res = await fetch("/api/" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error(t("offline"));
    }
    const out = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showGate(code ? out.error : "");
      throw new Error(out.error || t("needCode"));
    }
    if (!res.ok) throw new Error(out.error || t("failed", res.status));
    if (out.state) setData(out.state);
    return out;
  }

  function setData(state) {
    data = state;
    lastLoaded = Date.now();
    render();
  }

  async function load() {
    try {
      const state = await api("state");
      hideGate();
      setData(state);
    } catch (e) {
      if (!data && $("#gate").hidden) {
        $("#board").innerHTML = `<p class="empty-note">${esc(e.message)}</p>`;
      }
    }
  }

  // ---------- derived numbers ----------
  function legStats(legId) {
    const trips = data.trips.filter((x) => x.leg === legId);
    const offered = trips.reduce((n, x) => n + x.seats, 0);
    const taken = trips.reduce((n, x) => n + x.passengers.length, 0);
    const looking = data.requests.filter((r) => r.leg === legId).length;
    return { trips: trips.length, offered, taken, free: offered - taken, looking, short: Math.max(0, looking - (offered - taken)) };
  }
  // Rides with no time yet go last.
  const byTime = (a, b) => (a.time ? 0 : 1) - (b.time ? 0 : 1) || a.time.localeCompare(b.time) || a.createdAt - b.createdAt;

  // ---------- rendering ----------
  function render() {
    if (!data) return;
    renderMine();
    renderLegChips();
    renderBoard();
    $("#admin-banner").hidden = !adminKey;
    renderUpdated();
  }

  function renderUpdated() {
    if (!lastLoaded) return;
    const hm = new Date(lastLoaded).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("#updated").textContent = t("updated", hm);
  }

  // A ride this phone has a seat in (or drives) going the same way as `leg`, on another day.
  const mySeatSameWay = (leg) =>
    data.trips.find(
      (x) => x.leg !== leg.id && legById[x.leg] && legById[x.leg].direction === leg.direction && (isMine(x.id) || x.passengers.some((p) => isMine(p.id)))
    );

  const removeBtn = (tripId, p) =>
    `<button type="button" class="link danger" data-act="remove-pax" data-trip="${esc(tripId)}" data-pax="${esc(p.id)}" aria-label="${esc(t("removeName", p.name))}">${esc(t("remove"))}</button>`;

  function renderMine() {
    const rows = [];
    for (const trip of data.trips.slice().sort(byTime)) {
      const leg = legById[trip.leg];
      const when = `${leg ? legName(leg) : trip.leg} ${timeText(trip)}`;
      if (isMine(trip.id)) {
        const looking = data.requests.filter((r) => r.leg === trip.leg).length;
        const free = trip.seats - trip.passengers.length;
        const paxList = trip.passengers.length
          ? `<ul class="mine-pax">${trip.passengers
              .map(
                (p) =>
                  `<li><span class="name">${esc(p.name)}</span>${contactHtml(p.contact)}${wantsHtml(p, leg)}${aroundHtml(p)}${isMine(p.id) ? "" : removeBtn(trip.id, p)}</li>`
              )
              .join("")}</ul>`
          : `<p class="mine-empty">${esc(t("nobodyYet"))}</p>`;
        const add =
          free > 0 && looking
            ? `<button type="button" class="btn small" data-act="add-someone" data-trip="${esc(trip.id)}">${esc(t("addSomeone", looking))}</button>`
            : "";
        rows.push(
          `<li class="mine-trip"><div class="mine-head"><span class="what">${esc(t("youDrive", trip.passengers.length, trip.seats))}</span><span class="when">${esc(when)}</span></div>${paxList}${add}</li>`
        );
      }
      for (const p of trip.passengers) {
        if (isMine(p.id)) {
          rows.push(
            `<li><span class="what">${esc(t("seatWith", trip.driver))}</span><span class="when">${esc(when)} · ${esc(trip.pickup)}</span>${contactHtml(trip.contact)}</li>`
          );
        }
      }
    }
    for (const r of data.requests) {
      if (isMine(r.id)) {
        const leg = legById[r.leg];
        const seat = leg && mySeatSameWay(leg);
        rows.push(
          `<li><span class="what">${esc(t("youLook"))}</span><span class="when">${esc(leg ? legName(leg) : r.leg)}</span>${
            seat
              ? `<span class="also-listed">${esc(t("alsoListed", legName(legById[seat.leg])))}</span><button type="button" class="link danger" data-act="del-req" data-req="${esc(r.id)}">${esc(t("remove"))}</button>`
              : ""
          }</li>`
        );
      }
    }
    const el = $("#mine");
    el.hidden = rows.length === 0;
    el.innerHTML = rows.length ? `<h2>${esc(t("yourRides"))}</h2><ul>${rows.join("")}</ul>` : "";
  }

  // Day buttons: all days, or just one.
  function renderLegChips() {
    const chips = [
      `<button type="button" class="leg-chip" data-leg="all" aria-pressed="${filter === "all"}"><span class="l1">${esc(t("allDays"))}</span><span class="l2">${esc(t("cars", data.trips.length))}</span></button>`,
    ];
    for (const leg of legs) {
      const s = legStats(leg.id);
      const l2 = s.short ? t("chipShort", s.short) : t("chipOk", s.free, s.looking);
      chips.push(
        `<button type="button" class="leg-chip${s.short ? " short" : ""}" data-leg="${esc(leg.id)}" aria-pressed="${filter === leg.id}"><span class="l1">${esc(legName(leg))}</span><span class="l2">${esc(l2)}</span></button>`
      );
    }
    $("#legs").innerHTML = chips.join("");
  }

  // Two parts: the way there, then the way back, each with its days.
  function renderBoard() {
    const groups = [
      ["to", t("groupTo", ct("destination"))],
      ["from", t("groupBack")],
    ];
    $("#board").innerHTML = groups
      .map(([dir, title]) => {
        const ls = legs.filter((l) => l.direction === dir && (filter === "all" || l.id === filter));
        if (!ls.length) return "";
        return `<section class="dir-group"><h2 class="dir-title">${esc(title)}</h2>${ls.map(renderLeg).join("")}</section>`;
      })
      .join("");
  }

  function renderLeg(leg) {
    const s = legStats(leg.id);
    const trips = data.trips.filter((x) => x.leg === leg.id).sort(byTime);
    const reqs = data.requests.filter((r) => r.leg === leg.id).sort((a, b) => a.createdAt - b.createdAt);

    let pill;
    if (!s.trips && !s.looking) pill = `<span class="pill">${esc(t("noOneYet"))}</span>`;
    else if (s.short) pill = `<span class="pill short">${esc(t("pillShort", s.short))}</span>`;
    else pill = `<span class="pill ok">${esc(t("pillOk", s.free, s.looking))}</span>`;

    const tripsHtml = trips.length
      ? `<div class="trips">${trips.map(renderTrip).join("")}</div>`
      : `<div class="empty-leg"><span>${esc(t("noCars"))}</span><button type="button" class="btn small" data-act="drive" data-leg="${esc(leg.id)}">${esc(t("addYourCar"))}</button></div>`;

    const reqHtml = reqs.length
      ? `<div class="looking"><h3>${esc(t("stillLooking", reqs.length))}</h3><ul class="req-list">${reqs.map((r) => renderRequest(r, leg)).join("")}</ul></div>`
      : "";

    return `<section class="leg" id="leg-${esc(leg.id)}">
      <div class="leg-head">
        <h3>${esc(legDay(leg))}</h3>
        ${pill}
      </div>
      ${tripsHtml}
      ${reqHtml}
    </section>`;
  }

  const TRUNK_KEYS = ["roomy", "normal", "tight"];

  function renderTrip(trip) {
    const leg = legById[trip.leg];
    const free = trip.seats - trip.passengers.length;
    const driver = isMine(trip.id);
    const mySeat = trip.passengers.find((p) => isMine(p.id));
    const dots = Array.from({ length: trip.seats }, (_, i) => `<span class="dot${i < trip.passengers.length ? " taken" : ""}"></span>`).join("");
    const canManage = driver || adminKey;
    const you = " " + t("you");

    const actions = [];
    if (mySeat) actions.push(`<span class="my-seat">${esc(t("yourSeatHere"))}</span>`);
    actions.push(...tripButtons(trip));
    actions.push(`<button type="button" class="link who-btn" data-act="details" data-trip="${esc(trip.id)}">${esc(t("whoIn", trip.passengers.length))}</button>`);

    return `<article class="trip${free <= 0 ? " full" : ""}${driver ? " is-mine" : ""}${mySeat ? " has-me" : ""}" data-card="${esc(trip.id)}">
      <div class="trip-time"><span class="t${trip.time ? "" : " tbd"}">${esc(timeText(trip))}</span><span class="d">${esc(leg ? dayShort(leg) : "")}</span></div>
      <div class="trip-main">
        <div class="route">${placeHtml(trip)}</div>
        <div class="who"><span class="role">${esc(t("driver"))}</span><span class="name">${esc(trip.driver)}${driver ? esc(you) : ""}</span>${contactHtml(trip.contact)}</div>
        <div class="seatline">
          <span class="dots" aria-hidden="true">${dots}</span>
          <span class="seat-text${free > 0 ? " free" : ""}">${esc(free > 0 ? t("freeOf", free, trip.seats) : t("full"))}</span>
          <span class="trunk">${esc(t("trunk")[trip.luggage] || "")}</span>
        </div>
        ${trip.flexible ? `<p class="flex-note">${esc(trip.time ? t("flexGuess", trip.driver) : t("flexOpen", trip.driver))}</p>` : ""}
        ${trip.note ? `<p class="note">${esc(trip.note)}</p>` : ""}
        <div class="trip-actions">${actions.join("")}</div>
      </div>
    </article>`;
  }

  // Buttons for a ride, shown on its card and in its pop-up.
  function tripButtons(trip) {
    const free = trip.seats - trip.passengers.length;
    const driver = isMine(trip.id);
    const mySeat = trip.passengers.find((p) => isMine(p.id));
    const canManage = driver || adminKey;
    const lookingHere = data.requests.filter((r) => r.leg === trip.leg).length;
    const id = esc(trip.id);
    const out = [];
    if (mySeat) out.push(`<button type="button" class="link danger" data-act="leave" data-trip="${id}" data-pax="${esc(mySeat.id)}">${esc(t("giveUp"))}</button>`);
    else if (!driver && free > 0) out.push(`<button type="button" class="btn small primary" data-act="take" data-trip="${id}">${esc(t("takeSeat"))}</button>`);
    if (canManage && free > 0 && lookingHere) {
      out.push(`<button type="button" class="btn small" data-act="add-someone" data-trip="${id}">${esc(t("addSomeone", lookingHere))}</button>`);
    }
    if (canManage) {
      out.push(`<button type="button" class="link" data-act="edit-trip" data-trip="${id}">${esc(t("editRide"))}</button>`);
      out.push(`<button type="button" class="link danger" data-act="cancel-trip" data-trip="${id}">${esc(t("cancelRide"))}</button>`);
    }
    return out;
  }

  // Pop-up card for one ride: who's in it, and everything you can do with it.
  function tripDetails(tripId) {
    const trip = data.trips.find((x) => x.id === tripId);
    if (!trip) return;
    const leg = legById[trip.leg];
    const free = trip.seats - trip.passengers.length;
    const canManage = isMine(trip.id) || adminKey;
    const you = " " + t("you");
    const dots = Array.from({ length: trip.seats }, (_, i) => `<span class="dot${i < trip.passengers.length ? " taken" : ""}"></span>`).join("");
    const pax = trip.passengers
      .map((p) => {
        const mineP = isMine(p.id);
        const details = canManage ? contactHtml(p.contact) + wantsHtml(p, leg) + aroundHtml(p) + noteHtml(p, "span") : "";
        return `<li class="${mineP ? "me" : ""}"><div class="pax-main"><span class="name">${esc(p.name)}${mineP ? esc(you) : ""}</span>${details}</div>${
          canManage && !mineP ? removeBtn(trip.id, p) : ""
        }</li>`;
      })
      .join("");
    const buttons = tripButtons(trip);
    openDialog({
      title: `${leg ? legName(leg) : ""} · ${timeText(trip)}`,
      cancel: t("close"),
      body: `
        <div class="detail-card">
          <div class="route">${placeHtml(trip)}</div>
          <div class="who"><span class="role">${esc(t("driver"))}</span><span class="name">${esc(trip.driver)}${isMine(trip.id) ? esc(you) : ""}</span>${contactHtml(trip.contact)}</div>
          <div class="seatline">
            <span class="dots" aria-hidden="true">${dots}</span>
            <span class="seat-text${free > 0 ? " free" : ""}">${esc(free > 0 ? t("freeOf", free, trip.seats) : t("full"))}</span>
            <span class="trunk">${esc(t("trunk")[trip.luggage] || "")}</span>
          </div>
          ${trip.flexible ? `<p class="flex-note">${esc(trip.time ? t("flexGuess", trip.driver) : t("flexOpen", trip.driver))}</p>` : ""}
          ${trip.note ? `<p class="note">${esc(trip.note)}</p>` : ""}
        </div>
        <div class="detail-pax">
          <h3>${esc(t("passengers"))} (${trip.passengers.length}/${trip.seats})</h3>
          ${pax ? `<ul class="pax-list">${pax}</ul>` : `<p class="mine-empty">${esc(t("nobodyInCar"))}</p>`}
        </div>
        ${buttons.length ? `<div class="trip-actions">${buttons.join("")}</div>` : ""}`,
      onOpen(root) {
        root.onclick = onAct;
      },
    });
  }

  function renderRequest(r, leg) {
    const own = isMine(r.id);
    const myTripHere = data.trips.find((x) => x.leg === leg.id && isMine(x.id) && x.passengers.length < x.seats);
    const actions = [];
    if (myTripHere && !own) {
      actions.push(`<button type="button" class="btn small" data-act="pick" data-trip="${esc(myTripHere.id)}" data-req="${esc(r.id)}">${esc(t("addToMyCar"))}</button>`);
    }
    if (own || adminKey) {
      actions.push(`<button type="button" class="link danger" data-act="del-req" data-req="${esc(r.id)}">${esc(own ? t("imSorted") : t("remove"))}</button>`);
    }
    return `<li class="req${own ? " me" : ""}">
      <div class="req-main">
        <div class="req-top"><span class="name" data-you="${esc(t("you"))}">${esc(r.name)}</span>${wantsHtml(r, leg)}${aroundHtml(r)}</div>
        <div class="req-top">${contactHtml(r.contact)}</div>
        ${noteHtml(r)}
      </div>
      <div class="req-actions">${actions.join("")}</div>
    </li>`;
  }

  // ---------- dialog ----------
  const dlg = $("#dlg");
  let dlgHandler = null;

  function openDialog({ title, body, submit = t("save"), cancel = t("cancel"), danger = false, onSubmit, onOpen }) {
    $("#dlg-title").textContent = title;
    $("#dlg-body").innerHTML = body;
    $("#dlg-body").onclick = null;
    $("#dlg-error").hidden = true;
    const btn = $("#dlg-submit");
    btn.textContent = submit;
    btn.disabled = false;
    btn.classList.toggle("danger", danger);
    btn.classList.toggle("primary", !danger);
    btn.hidden = !onSubmit;
    $("#dlg-cancel").textContent = cancel;
    dlgHandler = onSubmit;
    if (!dlg.open) dlg.showModal();
    if (onOpen) onOpen($("#dlg-body"));
    const first = $("#dlg-body").querySelector("input:not([type=radio]):not([type=checkbox]), select, textarea");
    if (first && !first.value && window.matchMedia("(pointer: fine)").matches) first.focus();
  }
  function closeDialog() {
    dlgHandler = null;
    if (dlg.open) dlg.close();
  }
  function dialogError(msg) {
    const el = $("#dlg-error");
    el.textContent = msg;
    el.hidden = false;
  }

  $("#dlg-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!dlgHandler) return closeDialog();
    const form = e.currentTarget;
    if (!form.reportValidity()) return;
    const btn = $("#dlg-submit");
    btn.disabled = true;
    $("#dlg-error").hidden = true;
    try {
      const handler = dlgHandler;
      const keepOpen = await handler(new FormData(form), form);
      if (!keepOpen && dlgHandler === handler) closeDialog();
    } catch (err) {
      dialogError(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  $("#dlg-cancel").addEventListener("click", closeDialog);
  $("#dlg-close").addEventListener("click", closeDialog);
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) closeDialog();
  });

  // `text` is HTML; escape any names before passing them in.
  function confirmBox(title, text, action, run) {
    openDialog({
      title,
      body: `<p class="dlg-lead">${text}</p>`,
      submit: action,
      cancel: t("keepIt"),
      danger: true,
      onSubmit: run,
    });
  }

  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }

  // ---------- form pieces ----------
  const opt = () => `<small>${esc(t("optional"))}</small>`;
  const personFields = (name, contact) => `
    <div class="row2">
      <label class="field"><span>${esc(t("yourName"))}</span><input id="f-name" name="name" required maxlength="40" autocomplete="name" value="${esc(name)}"></label>
      <label class="field"><span>${esc(t("waNumber"))}</span><input id="f-contact" name="contact" required maxlength="40" inputmode="tel" autocomplete="tel" value="${esc(contact)}" placeholder="+371 2…"></label>
    </div>`;

  // ---------- flows ----------
  function driveForm(trip, presetLeg, prefill) {
    const editing = !!trip;
    const v = trip || {
      leg: presetLeg || (filter !== "all" ? filter : legs[0].id),
      time: "",
      flexible: false,
      pickup: "",
      seats: 3,
      luggage: "normal",
      driver: me.name,
      contact: me.contact,
      note: "",
      ...(prefill || {}),
    };
    const legChoices = legs
      .map(
        (l) =>
          `<label class="choice"><input type="radio" name="leg" value="${esc(l.id)}" ${l.id === v.leg ? "checked" : ""} required><span>${esc(legName(l))}</span></label>`
      )
      .join("");
    const trunk = TRUNK_KEYS.map(
      (k) => `<label class="choice"><input type="radio" name="luggage" value="${k}" ${k === v.luggage ? "checked" : ""}><span>${esc(t("trunk")[k])}</span></label>`
    ).join("");

    openDialog({
      title: editing ? t("editTitle") : t("offerTitle"),
      submit: editing ? t("saveChanges") : t("postRide"),
      body: `
        <fieldset class="fieldset"><legend>${esc(t("whichTrip"))}</legend><div class="choices">${legChoices}</div>
          ${editing ? "" : `<small>${esc(t("bothWays"))}</small>`}</fieldset>
        <div class="row2">
          <label class="field"><span id="f-time-label"></span><input id="f-time" type="time" name="time" required value="${esc(v.time)}"></label>
          <div class="field"><span>${esc(t("peopleYouTake"))}</span>
            <div class="stepper"><button type="button" data-step="-1" aria-label="${esc(t("fewerSeats"))}">−</button><output id="f-seats-out">${v.seats}</output><button type="button" data-step="1" aria-label="${esc(t("moreSeats"))}">+</button></div>
            <input type="hidden" name="seats" id="f-seats" value="${v.seats}">
          </div>
        </div>
        <label class="check" id="f-flex-wrap"><input type="checkbox" id="f-flex" name="flexible" ${v.flexible ? "checked" : ""}><span>${esc(t("notSure"))}</span></label>
        <label class="field"><span id="f-place-label"></span><input id="f-pickup" name="pickup" required maxlength="100" value="${esc(v.pickup)}" placeholder="${esc(t("addressExample"))}" autocomplete="off"><small id="f-place-hint"></small></label>
        <fieldset class="fieldset"><legend>${esc(t("trunkSpace"))}</legend><div class="choices">${trunk}</div></fieldset>
        ${personFields(v.driver, v.contact)}
        <label class="field"><span>${esc(t("note"))} ${opt()}</span><textarea id="f-note" name="note" maxlength="280" placeholder="">${esc(v.note)}</textarea></label>`,
      onOpen(root) {
        const flex = $("#f-flex", root);
        const timeIn = $("#f-time", root);
        const syncLeg = () => {
          const chosen = $("input[name=leg]:checked", root);
          const back = isBack(chosen && legById[chosen.value]);
          const words = back ? t("placeBack") : t("placeTo");
          $("#f-place-label", root).textContent = words.label;
          $("#f-place-hint", root).textContent = words.hint;
          $("#f-note", root).placeholder = words.note;
          // "Not sure yet" is mainly for the way back, but never hide it once it's on.
          $("#f-flex-wrap", root).hidden = !back && !flex.checked;
        };
        const syncFlex = () => {
          timeIn.required = !flex.checked;
          $("#f-time-label", root).textContent = flex.checked ? t("leavingAround") : t("leavingAt");
        };
        $$("input[name=leg]", root).forEach((r) => r.addEventListener("change", syncLeg));
        flex.addEventListener("change", () => {
          syncFlex();
          syncLeg();
        });
        syncLeg();
        syncFlex();

        const out = $("#f-seats-out", root);
        const input = $("#f-seats", root);
        const min = trip ? Math.max(1, trip.passengers.length) : 1;
        $$("[data-step]", root).forEach((b) =>
          b.addEventListener("click", () => {
            const n = Math.min(C.maxSeats || 7, Math.max(min, Number(input.value) + Number(b.dataset.step)));
            input.value = n;
            out.textContent = n;
          })
        );
      },
      async onSubmit(fd) {
        const body = {
          leg: fd.get("leg"),
          time: fd.get("time") || "",
          flexible: fd.get("flexible") === "on",
          seats: Number(fd.get("seats")),
          pickup: String(fd.get("pickup") || "").trim(),
          luggage: fd.get("luggage") || "normal",
          driver: String(fd.get("name")).trim(),
          contact: String(fd.get("contact")).trim(),
          note: String(fd.get("note") || ""),
        };
        rememberMe(body.driver, body.contact);
        if (editing) {
          await api(`trips/${trip.id}`, { method: "PATCH", body, token: mine[trip.id] });
          toast(t("rideUpdated"));
          return;
        }
        const res = await api("trips", { method: "POST", body });
        remember(res.id, res.token);
        const leg = legById[body.leg];
        // Suggest the last return trip (Sunday) first: that's when most people head home.
        const back =
          leg && leg.direction === "to"
            ? legs
                .slice()
                .reverse()
                .find((l) => l.direction === "from" && !data.trips.some((x) => isMine(x.id) && x.leg === l.id))
            : null;
        if (back) {
          openDialog({
            title: t("rideUpTitle"),
            body: `<p class="dlg-lead">${esc(t("rideUpLead"))}</p>`,
            submit: t("addTripBack"),
            cancel: t("notNow"),
            onSubmit: async () => {
              driveForm(null, back.id, { seats: body.seats, luggage: body.luggage, pickup: body.pickup, flexible: true, note: "" });
              return true;
            },
          });
          return true;
        }
        toast(t("ridePosted"));
      },
    });
  }

  function needForm(presetLeg) {
    const already = new Set(data.requests.filter((r) => isMine(r.id)).map((r) => r.leg));
    const seated = new Set(data.trips.filter((x) => x.passengers.some((p) => isMine(p.id))).map((x) => x.leg));
    const choices = legs
      .map((l) => {
        const busy = already.has(l.id) || seated.has(l.id);
        const checked = !busy && (presetLeg ? l.id === presetLeg : filter === l.id);
        return `<label class="choice"><input type="checkbox" name="legs" value="${esc(l.id)}" ${checked ? "checked" : ""} ${busy ? "disabled" : ""}><span>${esc(legName(l))}${busy ? " ✓" : ""}</span></label>`;
      })
      .join("");
    const areaOpts = AREAS.map((a) => `<option>${esc(a)}</option>`).join("");
    openDialog({
      title: t("needTitle"),
      submit: t("needSubmit"),
      body: `
        <p class="dlg-lead">${t("needLead")}</p>
        <fieldset class="fieldset"><legend>${esc(t("whichTrips"))}</legend><div class="choices">${choices}</div><small>${esc(t("whichTripsHint"))}</small></fieldset>
        <label class="field"><span id="f-area-label"></span>
          <select id="f-area" name="area"><option value="">${esc(t("anywhere"))}</option>${areaOpts}</select></label>
        <label class="field"><span>${esc(t("whereExactly"))} ${opt()}</span><input id="f-pickup" name="pickup" maxlength="100" autocomplete="off" placeholder="${esc(t("whereExample"))}"></label>
        <label class="field"><span>${esc(t("roughTime"))} ${opt()}</span><input id="f-time" type="time" name="time"><small>${esc(t("roughTimeHint"))}</small></label>
        ${personFields(me.name, me.contact)}
        <label class="field"><span>${esc(t("note"))} ${opt()}</span><textarea id="f-note" name="note" maxlength="200" placeholder="${esc(t("needNoteExample"))}"></textarea></label>`,
      onOpen(root) {
        // Mention drop-off when only return trips are picked.
        const sync = () => {
          const picked = $$("input[name=legs]:checked", root).map((i) => legById[i.value]);
          const allBack = picked.length > 0 && picked.every(isBack);
          const anyBack = picked.some(isBack);
          $("#f-area-label", root).textContent = allBack ? t("areaBack") : anyBack ? t("areaMixed") : t("areaTo");
        };
        $$("input[name=legs]", root).forEach((i) => i.addEventListener("change", sync));
        sync();
      },
      async onSubmit(fd) {
        const chosen = fd.getAll("legs");
        if (!chosen.length) throw new Error(t("pickOneTrip"));
        const base = {
          name: String(fd.get("name")).trim(),
          contact: String(fd.get("contact")).trim(),
          area: String(fd.get("area") || ""),
          pickup: String(fd.get("pickup") || "").trim(),
          time: String(fd.get("time") || ""),
          note: String(fd.get("note") || ""),
        };
        rememberMe(base.name, base.contact);
        for (const leg of chosen) {
          const res = await api("requests", { method: "POST", body: { ...base, leg } });
          remember(res.id, res.token);
        }
        toast(chosen.length > 1 ? t("onListMany") : t("onList"));
      },
    });
  }

  function takeSeat(tripId) {
    const trip = data.trips.find((x) => x.id === tripId);
    if (!trip) return;
    const leg = legById[trip.leg];
    const back = isBack(leg);
    const myReq = data.requests.find((r) => r.leg === trip.leg && isMine(r.id));
    const already = data.trips.find((x) => x.leg === trip.leg && x.passengers.some((p) => isMine(p.id)));
    openDialog({
      title: t("takeTitle"),
      submit: t("takeSubmit"),
      body: `
        <p class="dlg-lead">${t("takeLead", esc(trip.driver), esc(leg ? legName(leg) : ""), trip.time ? esc(timeText(trip)) : "", placeHtml(trip))}</p>
        ${already ? `<p class="form-error" style="margin:0">${esc(t("alreadySeated", already.driver))}</p>` : ""}
        ${
          myReq
            ? `<p class="dlg-lead">${esc(t("comesOffList"))}</p>`
            : personFields(me.name, me.contact) +
              `<label class="field"><span>${esc(back ? t("whereDrop") : t("wherePick"))} ${opt()}</span><input name="pickup" maxlength="100" autocomplete="off" placeholder="${esc(t("seatExample"))}"></label>`
        }
        <p class="dlg-lead">${esc(back ? t("messageBack", trip.driver) : t("messageTo", trip.driver))}</p>`,
      async onSubmit(fd) {
        if (myReq) {
          await api(`trips/${trip.id}/seats`, { method: "POST", body: { requestId: myReq.id }, token: mine[myReq.id] });
        } else {
          const body = { name: String(fd.get("name")).trim(), contact: String(fd.get("contact")).trim(), pickup: String(fd.get("pickup") || "").trim() };
          rememberMe(body.name, body.contact);
          const res = await api(`trips/${trip.id}/seats`, { method: "POST", body });
          remember(res.id, res.token);
        }
        toast(t("inCar", trip.driver));
        return askAboutOtherDays(leg);
      },
    });
  }

  // After getting a seat: if this phone is still on the looking list for the same
  // direction on another day, ask whether that's still needed. Returns true when
  // the question is shown, so the dialog stays open.
  function askAboutOtherDays(leg) {
    if (!leg) return false;
    const others = data.requests.filter((r) => isMine(r.id) && r.leg !== leg.id && legById[r.leg] && legById[r.leg].direction === leg.direction);
    if (!others.length) return false;
    openDialog({
      title: t("otherDayTitle"),
      body: `<p class="dlg-lead">${esc(t("otherDayText", others.map((r) => legName(legById[r.leg])).join(", ")))}</p>`,
      submit: t("takeMeOff"),
      cancel: t("keepIt"),
      onSubmit: async () => {
        for (const r of others) await api(`requests/${r.id}`, { method: "DELETE", token: mine[r.id] });
        toast(t("removedFromList"));
      },
    });
    return true;
  }

  // Driver: pick people from the Still looking list for this trip's day.
  function addPicker(tripId) {
    const trip = data.trips.find((x) => x.id === tripId);
    if (!trip) return closeDialog();
    const leg = legById[trip.leg];
    const free = trip.seats - trip.passengers.length;
    const reqs = data.requests.filter((r) => r.leg === trip.leg).sort((a, b) => a.createdAt - b.createdAt);
    if (!reqs.length || free <= 0) {
      closeDialog();
      return;
    }
    const rows = reqs
      .map(
        (r) => `<li class="pick-row"><div class="pax-main"><span class="name">${esc(r.name)}</span>${contactHtml(r.contact)}${wantsHtml(r, leg)}${aroundHtml(r)}${noteHtml(r, "span")}</div>
          <button type="button" class="btn small primary" data-pick="${esc(r.id)}">${esc(t("add"))}</button></li>`
      )
      .join("");
    openDialog({
      title: t("pickTitle"),
      cancel: t("done"),
      body: `<p class="dlg-lead">${esc(t("pickLead", free, leg ? legName(leg) : ""))}</p><ul class="pick-list">${rows}</ul>`,
      onOpen(root) {
        root.onclick = async (e) => {
          const b = e.target.closest("[data-pick]");
          if (!b) return;
          b.disabled = true;
          try {
            await api(`trips/${trip.id}/seats`, { method: "POST", body: { requestId: b.dataset.pick }, token: mine[trip.id] });
            toast(t("addedToCar"));
            addPicker(tripId);
          } catch (err) {
            b.disabled = false;
            dialogError(err.message);
          }
        };
      },
    });
  }

  function summaryText() {
    const lines = [t("sumTitle", ct("eventName")), ""];
    for (const leg of legs) {
      const trips = data.trips.filter((x) => x.leg === leg.id).sort(byTime);
      const reqs = data.requests.filter((r) => r.leg === leg.id);
      lines.push(`*${legDay(leg)}, ${legDir(leg)}*`);
      if (!trips.length) lines.push(t("sumNoCars"));
      for (const trip of trips) {
        const free = trip.seats - trip.passengers.length;
        const where = isBack(leg) ? t("sumDrop", trip.pickup) : t("sumFrom", trip.pickup);
        const when = trip.time ? timeText(trip) : t("sumTimeTbd");
        lines.push(`• ${when} ${trip.driver}, ${where}: ${free > 0 ? t("sumFree", free) : t("sumFull")} (${trip.passengers.length}/${trip.seats})`);
      }
      if (reqs.length) lines.push(t("sumLooking", reqs.map((r) => r.name).join(", ")));
      lines.push("");
    }
    lines.push(t("sumLink", location.origin));
    return lines.join("\n");
  }

  async function copySummary() {
    const textOut = summaryText();
    try {
      await navigator.clipboard.writeText(textOut);
      toast(t("copied"));
    } catch {
      openDialog({
        title: t("sumBoxTitle"),
        body: `<textarea class="summary-box" id="f-summary" readonly>${esc(textOut)}</textarea><p class="dlg-lead">${esc(t("sumBoxLead"))}</p>`,
        cancel: t("close"),
        onOpen(root) {
          const ta = $("#f-summary", root);
          ta.focus();
          ta.select();
        },
      });
    }
  }

  function adminLogin() {
    openDialog({
      title: t("adminTitle"),
      submit: t("unlock"),
      body: `<p class="dlg-lead">${esc(t("adminLead"))}</p>
        <label class="field"><span>${esc(t("adminKey"))}</span><input id="f-admin" name="key" type="password" required autocomplete="off"></label>`,
      async onSubmit(fd) {
        const prev = adminKey;
        adminKey = String(fd.get("key"));
        try {
          await api("admin");
        } catch (e) {
          adminKey = prev;
          throw e;
        }
        store.set("gt.admin", adminKey);
        render();
        toast(t("adminOn"));
      },
    });
  }

  // ---------- event wiring ----------
  $("#btn-drive").addEventListener("click", () => data && driveForm());
  $("#btn-need").addEventListener("click", () => data && needForm());
  $("#btn-summary").addEventListener("click", () => data && copySummary());
  $("#btn-admin").addEventListener("click", adminLogin);
  $("#btn-admin-exit").addEventListener("click", () => {
    adminKey = "";
    store.set("gt.admin", "");
    render();
  });
  $("#btn-lang").addEventListener("click", () => {
    lang = lang === "lv" ? "en" : "lv";
    store.set("gt.lang", lang);
    closeDialog();
    applyStatic();
    render();
  });

  $("#legs").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-leg]");
    if (!chip) return;
    filter = chip.dataset.leg;
    store.set("gt.filter", filter);
    render();
  });

  const onAct = (e) => {
    if (!data) return;
    const b = e.target.closest("[data-act]");
    if (!b) {
      // Tapping a ride card (anywhere but a link or button) opens its pop-up.
      const card = e.target.closest("[data-card]");
      if (card && !e.target.closest("a, button")) tripDetails(card.dataset.card);
      return;
    }
    const { act, trip: tripId, pax: paxId, req: reqId } = b.dataset;
    const trip = tripId && data.trips.find((x) => x.id === tripId);

    if (act === "details") return tripDetails(tripId);
    if (act === "drive") return driveForm(null, b.dataset.leg);
    if (act === "take") return takeSeat(tripId);
    if (act === "add-someone") return addPicker(tripId);
    if (act === "edit-trip" && trip) return driveForm(trip);

    if (act === "cancel-trip" && trip) {
      const n = trip.passengers.length;
      return confirmBox(t("cancelQ"), esc(n ? t("cancelPax", n) : t("cancelEmpty")), t("cancelRide"), async () => {
        await api(`trips/${trip.id}`, { method: "DELETE", token: mine[trip.id] });
        toast(t("rideCancelled"));
      });
    }
    if (act === "leave" && trip) {
      return confirmBox(t("leaveQ"), esc(t("leaveText", trip.driver)), t("leaveBtn"), async () => {
        await api(`trips/${trip.id}/seats/${paxId}`, { method: "DELETE", token: mine[paxId] });
        toast(t("seatFreed"));
      });
    }
    if (act === "remove-pax" && trip) {
      const p = trip.passengers.find((x) => x.id === paxId);
      return confirmBox(t("removeQ"), esc(t("removeText", p ? p.name : "?")), t("remove"), async () => {
        await api(`trips/${trip.id}/seats/${paxId}`, { method: "DELETE", token: mine[trip.id] });
        toast(t("paxRemoved"));
      });
    }
    if (act === "pick" && trip) {
      const r = data.requests.find((x) => x.id === reqId);
      return confirmBox(t("pickQ"), esc(t("pickText", r ? r.name : "?")), t("addToMyCar"), async () => {
        await api(`trips/${trip.id}/seats`, { method: "POST", body: { requestId: reqId }, token: mine[trip.id] });
        toast(t("addedToCar"));
      });
    }
    if (act === "del-req") {
      const own = isMine(reqId);
      return confirmBox(own ? t("delSelfQ") : t("delOtherQ"), esc(own ? t("delSelfText") : t("delOtherText")), t("remove"), async () => {
        await api(`requests/${reqId}`, { method: "DELETE", token: mine[reqId] });
        toast(t("removedFromList"));
      });
    }
  };
  $("#board").addEventListener("click", onAct);
  $("#mine").addEventListener("click", onAct);

  // ---------- event code gate ----------
  function showGate(msg) {
    $("#gate").hidden = false;
    const err = $("#gate-error");
    err.textContent = msg || "";
    err.hidden = !msg;
    $("#gate-code").value = "";
  }
  function hideGate() {
    $("#gate").hidden = true;
  }
  $("#gate-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    code = $("#gate-code").value.trim();
    store.set("gt.code", code);
    await load();
  });

  // ---------- static page text ----------
  function applyStatic() {
    document.documentElement.lang = lang;
    document.title = ct("eventName");
    $('meta[name="description"]').content = t("pageDescription");
    $("#event-name").textContent = ct("eventName");
    $("#gate-title").textContent = ct("eventName");
    $("#tagline").textContent = ct("tagline");
    $("#venue-note").textContent = ct("venueNote");
    $("#btn-lang").textContent = t("switchTo");
    $("#admin-banner-text").textContent = t("adminBanner");
    $("#btn-admin-exit").textContent = t("exit");
    $("#btn-drive").textContent = t("btnDrive");
    $("#btn-need").textContent = t("btnNeed");
    $("#legs").setAttribute("aria-label", t("filterLabel"));
    const loading = $("#board .loading");
    if (loading) loading.textContent = t("loading");
    $("#btn-summary").textContent = t("btnSummary");
    $("#wa-group").textContent = t("openGroup");
    $("#btn-admin").textContent = t("organizer");
    $("#gate-lead").textContent = t("gateLead");
    $("#gate-label").textContent = t("gateLabel");
    $("#gate-go").textContent = t("gateGo");
    $("#dlg-close").setAttribute("aria-label", t("close"));
    renderUpdated();
  }

  // ---------- boot ----------
  applyStatic();
  if (C.whatsappGroupUrl) {
    const a = $("#wa-group");
    a.href = C.whatsappGroupUrl;
    a.hidden = false;
  }

  load();
  setInterval(() => {
    if (document.visibilityState === "visible" && !dlg.open) load();
    else renderUpdated();
  }, 20000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastLoaded > 5000) load();
  });
})();
