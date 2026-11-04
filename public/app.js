(() => {
  "use strict";

  const C = window.CONFIG;
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

  const AREAS = C.areas || ["Centrs", "Vecrīga (Old Town)", "Skanste", "Teika", "Purvciems", "Pļavnieki", "Āgenskalns", "Imanta"];
  const legs = C.legs;
  const legById = Object.fromEntries(legs.map((l) => [l.id, l]));

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T12:00:00");
    if (isNaN(d)) return "";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  const dayShort = (leg) => leg.day.slice(0, 3);
  const legDay = (leg, short = false) => (short ? dayShort(leg) : leg.day) + (leg.date ? " " + fmtDate(leg.date) : "");
  const legDir = (leg) => (leg.direction === "to" ? `to ${C.destination}` : "back to the city");
  const legDirShort = (leg) => (leg.direction === "to" ? "there" : "back");
  const legName = (leg) => `${legDay(leg, true)} · ${legDirShort(leg)}`;

  const isBack = (leg) => !!leg && leg.direction === "from";

  // Free-text addresses open in Google Maps.
  function mapsUrl(place) {
    const q = [place, C.mapsCity].filter(Boolean).join(", ");
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
  }
  const placeLink = (place) =>
    `<a class="map-link" href="${esc(mapsUrl(place))}" target="_blank" rel="noopener" title="Open in Google Maps">${esc(place)}</a>`;

  // Time shown on a ride or request. Empty = nobody knows yet.
  const timeText = (t) => (t.time ? (t.flexible ? "~" + t.time : t.time) : "TBD");

  function route(trip) {
    const leg = legById[trip.leg];
    const there = C.destinationShort;
    const arrow = '<span class="arrow" aria-hidden="true">→</span>';
    if (isBack(leg)) return `${esc(there)} ${arrow} ${placeLink(trip.pickup)}`;
    return `${placeLink(trip.pickup)} ${arrow} ${esc(there)}`;
  }

  // Where a person wants to meet or be dropped off: "Pļavnieki · Spice"
  function wantsHtml(r, leg) {
    const bits = [];
    if (r.area) bits.push(esc(r.area));
    if (r.pickup) bits.push(placeLink(r.pickup));
    if (!bits.length) return "";
    return `<span class="from">${isBack(leg) ? "drop-off" : "from"} ${bits.join(" · ")}</span>`;
  }
  const aroundHtml = (r) => (r.time ? `<span class="from">around ${esc(r.time)}</span>` : "");

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
  let filter = store.get("gt.filter", "all");
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
    const headers = { "content-type": "application/json" };
    if (code) headers["x-event-code"] = code;
    if (adminKey) headers["x-admin-key"] = adminKey;
    if (token) headers["x-token"] = token;
    let res;
    try {
      res = await fetch("/api/" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error("Can't reach the server. Check your connection and try again.");
    }
    const out = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showGate(code ? out.error : "");
      throw new Error(out.error || "Enter the event code to continue.");
    }
    if (!res.ok) throw new Error(out.error || `Something went wrong (${res.status}).`);
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
    const trips = data.trips.filter((t) => t.leg === legId);
    const offered = trips.reduce((n, t) => n + t.seats, 0);
    const taken = trips.reduce((n, t) => n + t.passengers.length, 0);
    const looking = data.requests.filter((r) => r.leg === legId).length;
    return { trips: trips.length, offered, taken, free: offered - taken, looking, short: Math.max(0, looking - (offered - taken)) };
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
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
    const t = new Date(lastLoaded).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("#updated").textContent = `Updated ${t}`;
  }

  function renderMine() {
    const rows = [];
    for (const t of data.trips.slice().sort(byTime)) {
      const leg = legById[t.leg];
      const when = `${leg ? legName(leg) : t.leg} ${timeText(t)}`;
      if (isMine(t.id)) {
        const looking = data.requests.filter((r) => r.leg === t.leg).length;
        const free = t.seats - t.passengers.length;
        const paxList = t.passengers.length
          ? `<ul class="mine-pax">${t.passengers
              .map(
                (p) =>
                  `<li><span class="name">${esc(p.name)}</span>${contactHtml(p.contact)}${wantsHtml(p, leg)}${aroundHtml(p)}${
                    isMine(p.id) ? "" : `<button type="button" class="link danger" data-act="remove-pax" data-trip="${esc(t.id)}" data-pax="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">Remove</button>`
                  }</li>`
              )
              .join("")}</ul>`
          : `<p class="mine-empty">Nobody in your car yet.</p>`;
        const add =
          free > 0 && looking
            ? `<button type="button" class="btn small" data-act="add-someone" data-trip="${esc(t.id)}">Add someone (${looking} looking)</button>`
            : "";
        rows.push(
          `<li class="mine-trip"><div class="mine-head"><span class="what">You're driving · ${t.passengers.length}/${t.seats} seats taken</span><span class="when">${esc(when)}</span></div>${paxList}${add}</li>`
        );
      }
      for (const p of t.passengers) {
        if (isMine(p.id)) {
          rows.push(
            `<li><span class="what">Seat in ${esc(t.driver)}'s car</span><span class="when">${esc(when)} · ${esc(t.pickup)}</span>${contactHtml(t.contact)}</li>`
          );
        }
      }
    }
    for (const r of data.requests) {
      if (isMine(r.id)) {
        const leg = legById[r.leg];
        rows.push(`<li><span class="what">Looking for a ride</span><span class="when">${esc(leg ? legName(leg) : r.leg)}</span></li>`);
      }
    }
    const el = $("#mine");
    el.hidden = rows.length === 0;
    el.innerHTML = rows.length ? `<h2>Your rides</h2><ul>${rows.join("")}</ul>` : "";
  }

  function renderLegChips() {
    const chips = [
      `<button type="button" class="leg-chip" data-leg="all" aria-pressed="${filter === "all"}"><span class="l1">All days</span><span class="l2">${plural(data.trips.length, "car", "cars")}</span></button>`,
    ];
    for (const leg of legs) {
      const s = legStats(leg.id);
      const l2 = s.short ? `${s.short} short` : `${s.free} free · ${s.looking} looking`;
      chips.push(
        `<button type="button" class="leg-chip${s.short ? " short" : ""}" data-leg="${esc(leg.id)}" aria-pressed="${filter === leg.id}"><span class="l1">${esc(legName(leg))}</span><span class="l2">${esc(l2)}</span></button>`
      );
    }
    $("#legs").innerHTML = chips.join("");
  }

  function renderBoard() {
    const shown = filter === "all" ? legs : legs.filter((l) => l.id === filter);
    $("#board").innerHTML = shown.map(renderLeg).join("");
  }

  function renderLeg(leg) {
    const s = legStats(leg.id);
    const trips = data.trips.filter((t) => t.leg === leg.id).sort(byTime);
    const reqs = data.requests.filter((r) => r.leg === leg.id).sort((a, b) => a.createdAt - b.createdAt);

    let pill;
    if (!s.trips && !s.looking) pill = `<span class="pill">No one yet</span>`;
    else if (s.short) pill = `<span class="pill short">${plural(s.short, "seat", "seats")} short</span>`;
    else pill = `<span class="pill ok">${plural(s.free, "seat", "seats")} free · ${s.looking} looking</span>`;

    const tripsHtml = trips.length
      ? `<div class="trips">${trips.map(renderTrip).join("")}</div>`
      : `<div class="empty-leg"><span>No cars yet for this trip.</span><button type="button" class="btn small" data-act="drive" data-leg="${esc(leg.id)}">Add your car</button></div>`;

    const reqHtml = reqs.length
      ? `<div class="looking"><h3>Still looking (${reqs.length})</h3><ul class="req-list">${reqs.map((r) => renderRequest(r, leg)).join("")}</ul></div>`
      : "";

    return `<section class="leg" id="leg-${esc(leg.id)}">
      <div class="leg-head">
        <h2>${esc(legDay(leg))}<span class="dir">${esc(legDir(leg))}</span></h2>
        ${pill}
      </div>
      ${tripsHtml}
      ${reqHtml}
    </section>`;
  }

  const TRUNK = { roomy: "Plenty of trunk space", normal: "Normal trunk", tight: "Small bags only" };

  function renderTrip(t) {
    const leg = legById[t.leg];
    const free = t.seats - t.passengers.length;
    const driver = isMine(t.id);
    const mySeat = t.passengers.find((p) => isMine(p.id));
    const dots = Array.from({ length: t.seats }, (_, i) => `<span class="dot${i < t.passengers.length ? " taken" : ""}"></span>`).join("");
    const canManage = driver || adminKey;

    const pax = canManage
      ? t.passengers
          .map((p) => {
            const mineP = isMine(p.id);
            const details = wantsHtml(p, leg) + aroundHtml(p) + (p.note ? `<span class="from">${esc(p.note)}</span>` : "");
            return `<li class="${mineP ? "me" : ""}"><div class="pax-main"><span class="name">${esc(p.name)}${mineP ? " (you)" : ""}</span>${contactHtml(p.contact)}${details}</div>${
              mineP ? "" : `<button type="button" class="link danger" data-act="remove-pax" data-trip="${esc(t.id)}" data-pax="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">Remove</button>`
            }</li>`;
          })
          .join("")
      : t.passengers.map((p) => `<li class="${isMine(p.id) ? "me" : ""}">${esc(p.name)}${isMine(p.id) ? " (you)" : ""}</li>`).join("");
    const lookingHere = data.requests.filter((r) => r.leg === t.leg).length;

    const actions = [];
    if (mySeat) {
      actions.push(`<button type="button" class="link danger" data-act="leave" data-trip="${esc(t.id)}" data-pax="${esc(mySeat.id)}">Give up my seat</button>`);
    } else if (!driver && free > 0) {
      actions.push(`<button type="button" class="btn small primary" data-act="take" data-trip="${esc(t.id)}">Take a seat</button>`);
    }
    if (canManage && free > 0 && lookingHere) {
      actions.push(`<button type="button" class="btn small" data-act="add-someone" data-trip="${esc(t.id)}">Add someone (${lookingHere} looking)</button>`);
    }
    if (canManage) {
      actions.push(`<button type="button" class="link" data-act="edit-trip" data-trip="${esc(t.id)}">Edit ride</button>`);
      actions.push(`<button type="button" class="link danger" data-act="cancel-trip" data-trip="${esc(t.id)}">Cancel ride</button>`);
    }

    return `<article class="trip${free <= 0 ? " full" : ""}${driver ? " is-mine" : ""}">
      <div class="trip-time"><span class="t${t.time ? "" : " tbd"}">${esc(timeText(t))}</span><span class="d">${esc(leg ? dayShort(leg) : "")}</span></div>
      <div class="trip-main">
        <div class="route">${route(t)}</div>
        <div class="who"><span class="role">Driver</span><span class="name">${esc(t.driver)}${driver ? " (you)" : ""}</span>${contactHtml(t.contact)}</div>
        <div class="seatline">
          <span class="dots" aria-hidden="true">${dots}</span>
          <span class="seat-text${free > 0 ? " free" : ""}">${free > 0 ? `${free} of ${t.seats} free` : "Full"}</span>
          <span class="trunk">${esc(TRUNK[t.luggage] || "")}</span>
        </div>
        ${t.flexible ? `<p class="flex-note">${t.time ? "Time is a rough guess" : "Time not decided yet"}. Agree it with ${esc(t.driver)}.</p>` : ""}
        ${pax ? `<ul class="${canManage ? "pax-list" : "pax"}" aria-label="Passengers">${pax}</ul>` : ""}
        ${t.note ? `<p class="note">${esc(t.note)}</p>` : ""}
        ${actions.length ? `<div class="trip-actions">${actions.join("")}</div>` : ""}
      </div>
    </article>`;
  }

  function renderRequest(r, leg) {
    const own = isMine(r.id);
    const myTripHere = data.trips.find((t) => t.leg === leg.id && isMine(t.id) && t.passengers.length < t.seats);
    const actions = [];
    if (myTripHere && !own) {
      actions.push(`<button type="button" class="btn small" data-act="pick" data-trip="${esc(myTripHere.id)}" data-req="${esc(r.id)}">Add to my car</button>`);
    }
    if (own || adminKey) {
      actions.push(`<button type="button" class="link danger" data-act="del-req" data-req="${esc(r.id)}">${own ? "I'm sorted" : "Remove"}</button>`);
    }
    return `<li class="req${own ? " me" : ""}">
      <div class="req-main">
        <div class="req-top"><span class="name">${esc(r.name)}</span>${wantsHtml(r, leg)}${aroundHtml(r)}</div>
        <div class="req-top">${contactHtml(r.contact)}</div>
        ${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}
      </div>
      <div class="req-actions">${actions.join("")}</div>
    </li>`;
  }

  // ---------- dialog ----------
  const dlg = $("#dlg");
  let dlgHandler = null;

  function openDialog({ title, body, submit = "Save", cancel = "Cancel", danger = false, onSubmit, onOpen }) {
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

  function confirmBox(title, text, action, run) {
    openDialog({
      title,
      body: `<p class="dlg-lead">${text}</p>`,
      submit: action,
      cancel: "Keep it",
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
  const personFields = (name, contact, nameLabel = "Your name") => `
    <div class="row2">
      <label class="field"><span>${esc(nameLabel)}</span><input id="f-name" name="name" required maxlength="40" autocomplete="name" value="${esc(name)}"></label>
      <label class="field"><span>WhatsApp number</span><input id="f-contact" name="contact" required maxlength="40" inputmode="tel" autocomplete="tel" value="${esc(contact)}" placeholder="+371 2…"></label>
    </div>`;

  // Wording that depends on whether the trip goes there or back.
  const placeWords = (back) =>
    back
      ? { label: "Drop-off in the city", hint: "Where you'll drop people off. Opens in Google Maps." }
      : { label: "Meeting point in the city", hint: "Where you'll pick people up. Opens in Google Maps." };

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
    const trunk = Object.entries(TRUNK)
      .map(([k, label]) => `<label class="choice"><input type="radio" name="luggage" value="${k}" ${k === v.luggage ? "checked" : ""}><span>${esc(label)}</span></label>`)
      .join("");

    openDialog({
      title: editing ? "Edit your ride" : "Offer a ride",
      submit: editing ? "Save changes" : "Post my ride",
      body: `
        <fieldset class="fieldset"><legend>Which trip?</legend><div class="choices">${legChoices}</div>
          ${editing ? "" : "<small>Driving both ways? Post this one, then you can add the trip back.</small>"}</fieldset>
        <div class="row2">
          <label class="field"><span id="f-time-label">Leaving at</span><input id="f-time" type="time" name="time" required value="${esc(v.time)}"></label>
          <div class="field"><span>People you can take</span>
            <div class="stepper"><button type="button" data-step="-1" aria-label="Fewer seats">−</button><output id="f-seats-out">${v.seats}</output><button type="button" data-step="1" aria-label="More seats">+</button></div>
            <input type="hidden" name="seats" id="f-seats" value="${v.seats}">
          </div>
        </div>
        <label class="check" id="f-flex-wrap"><input type="checkbox" id="f-flex" name="flexible" ${v.flexible ? "checked" : ""}><span>Not sure when I'm leaving yet. I'll agree it with passengers.</span></label>
        <label class="field"><span id="f-place-label"></span><input id="f-pickup" name="pickup" required maxlength="100" value="${esc(v.pickup)}" placeholder="e.g. Brīvības iela 99, or Rimi Origo" autocomplete="off"><small id="f-place-hint"></small></label>
        <fieldset class="fieldset"><legend>Trunk space</legend><div class="choices">${trunk}</div></fieldset>
        ${personFields(v.driver, v.contact)}
        <label class="field"><span>Note <small>(optional)</small></span><textarea id="f-note" name="note" maxlength="280" placeholder="e.g. Can pick up anywhere along the way">${esc(v.note)}</textarea></label>`,
      onOpen(root) {
        const flex = $("#f-flex", root);
        const timeIn = $("#f-time", root);
        const syncLeg = () => {
          const chosen = $("input[name=leg]:checked", root);
          const back = isBack(chosen && legById[chosen.value]);
          const words = placeWords(back);
          $("#f-place-label", root).textContent = words.label;
          $("#f-place-hint", root).textContent = words.hint;
          // "Not sure yet" is mainly for the way back, but never hide it once it's on.
          $("#f-flex-wrap", root).hidden = !back && !flex.checked;
        };
        const syncFlex = () => {
          timeIn.required = !flex.checked;
          $("#f-time-label", root).textContent = flex.checked ? "Leaving around (optional)" : "Leaving at";
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
          toast("Ride updated");
          return;
        }
        const res = await api("trips", { method: "POST", body });
        remember(res.id, res.token);
        const leg = legById[body.leg];
        const back = leg && leg.direction === "to" ? legs.find((l) => l.direction === "from" && !data.trips.some((t) => isMine(t.id) && t.leg === l.id)) : null;
        if (back) {
          openDialog({
            title: "Your ride is up",
            body: `<p class="dlg-lead">People can now grab a seat. Are you driving back too? Add the return trip so people can plan the way home.</p>`,
            submit: "Add trip back",
            cancel: "Not now",
            onSubmit: async () => {
              driveForm(null, back.id, { seats: body.seats, luggage: body.luggage, pickup: body.pickup, flexible: true, note: "" });
              return true;
            },
          });
          return true;
        }
        toast("Ride posted");
      },
    });
  }

  function needForm(presetLeg) {
    const already = new Set(data.requests.filter((r) => isMine(r.id)).map((r) => r.leg));
    const seated = new Set(data.trips.filter((t) => t.passengers.some((p) => isMine(p.id))).map((t) => t.leg));
    const choices = legs
      .map((l) => {
        const busy = already.has(l.id) || seated.has(l.id);
        const checked = !busy && (presetLeg ? l.id === presetLeg : filter === l.id);
        return `<label class="choice"><input type="checkbox" name="legs" value="${esc(l.id)}" ${checked ? "checked" : ""} ${busy ? "disabled" : ""}><span>${esc(legName(l))}${busy ? " ✓" : ""}</span></label>`;
      })
      .join("");
    const areaOpts = AREAS.map((a) => `<option>${esc(a)}</option>`).join("");
    openDialog({
      title: "I need a ride",
      submit: "Add me to the list",
      body: `
        <p class="dlg-lead">You'll show up under <strong>Still looking</strong> so drivers can add you. You can also just pick a car with free seats.</p>
        <fieldset class="fieldset"><legend>Which trips?</legend><div class="choices">${choices}</div><small>Pick every trip you still need. ✓ = already sorted or listed.</small></fieldset>
        <label class="field"><span id="f-area-label">Best meeting point for you</span>
          <select id="f-area" name="area"><option value="">Anywhere is fine</option>${areaOpts}</select></label>
        <label class="field"><span>Where exactly? <small>(optional)</small></span><input id="f-pickup" name="pickup" maxlength="100" autocomplete="off" placeholder="e.g. Pļavnieki/Brīvības 99/Spice"></label>
        <label class="field"><span>Roughly what time? <small>(optional)</small></span><input id="f-time" type="time" name="time"><small>Helps drivers see if your plans match. Leave empty if you're flexible.</small></label>
        ${personFields(me.name, me.contact)}
        <label class="field"><span>Note <small>(optional)</small></span><textarea id="f-note" name="note" maxlength="200" placeholder="e.g. One big bag, flexible on time"></textarea></label>`,
      onOpen(root) {
        // Mention drop-off when only return trips are picked.
        const sync = () => {
          const picked = $$("input[name=legs]:checked", root).map((i) => legById[i.value]);
          const allBack = picked.length > 0 && picked.every(isBack);
          const anyBack = picked.some(isBack);
          $("#f-area-label", root).textContent = allBack ? "Where should you be dropped off?" : anyBack ? "Best meeting point / drop-off area" : "Best meeting point for you";
        };
        $$("input[name=legs]", root).forEach((i) => i.addEventListener("change", sync));
        sync();
      },
      async onSubmit(fd) {
        const chosen = fd.getAll("legs");
        if (!chosen.length) throw new Error("Pick at least one trip.");
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
        toast(chosen.length > 1 ? "You're on the list for those trips" : "You're on the list");
      },
    });
  }

  function takeSeat(tripId) {
    const t = data.trips.find((x) => x.id === tripId);
    if (!t) return;
    const leg = legById[t.leg];
    const back = isBack(leg);
    const myReq = data.requests.find((r) => r.leg === t.leg && isMine(r.id));
    const already = data.trips.find((x) => x.leg === t.leg && x.passengers.some((p) => isMine(p.id)));
    openDialog({
      title: "Take a seat",
      submit: "Take the seat",
      body: `
        <p class="dlg-lead"><strong>${esc(t.driver)}</strong> · ${esc(leg ? legName(leg) : "")} at <strong>${esc(timeText(t))}</strong> · ${route(t)}</p>
        ${already ? `<p class="form-error" style="margin:0">You already have a seat in ${esc(already.driver)}'s car for this trip. Give that one up first if you're switching.</p>` : ""}
        ${
          myReq
            ? `<p class="dlg-lead">You'll come off the Still looking list.</p>`
            : personFields(me.name, me.contact) +
              `<label class="field"><span>${back ? "Where should you be dropped off?" : "Where should they pick you up?"} <small>(optional)</small></span><input name="pickup" maxlength="100" autocomplete="off" placeholder="e.g. Brīvības 99"></label>`
        }
        <p class="dlg-lead">Message ${esc(t.driver)} on WhatsApp to agree ${back ? "the drop-off and time" : "where exactly to meet"}.</p>`,
      async onSubmit(fd) {
        if (myReq) {
          await api(`trips/${t.id}/seats`, { method: "POST", body: { requestId: myReq.id }, token: mine[myReq.id] });
        } else {
          const body = { name: String(fd.get("name")).trim(), contact: String(fd.get("contact")).trim(), pickup: String(fd.get("pickup") || "").trim() };
          rememberMe(body.name, body.contact);
          const res = await api(`trips/${t.id}/seats`, { method: "POST", body });
          remember(res.id, res.token);
        }
        toast(`You're in ${t.driver}'s car`);
      },
    });
  }

  // Driver: pick people from the Still looking list for this trip's day.
  function addPicker(tripId) {
    const t = data.trips.find((x) => x.id === tripId);
    if (!t) return closeDialog();
    const leg = legById[t.leg];
    const free = t.seats - t.passengers.length;
    const reqs = data.requests.filter((r) => r.leg === t.leg).sort((a, b) => a.createdAt - b.createdAt);
    if (!reqs.length || free <= 0) {
      closeDialog();
      return;
    }
    const rows = reqs
      .map(
        (r) => `<li class="pick-row"><div class="pax-main"><span class="name">${esc(r.name)}</span>${contactHtml(r.contact)}${wantsHtml(r, leg)}${aroundHtml(r)}${r.note ? `<span class="from">${esc(r.note)}</span>` : ""}</div>
          <button type="button" class="btn small primary" data-pick="${esc(r.id)}">Add</button></li>`
      )
      .join("");
    openDialog({
      title: "Add to your car",
      cancel: "Done",
      body: `<p class="dlg-lead">${plural(free, "seat", "seats")} left in your ${esc(leg ? legName(leg) : "")} car. Message them on WhatsApp to agree the details.</p><ul class="pick-list">${rows}</ul>`,
      onOpen(root) {
        root.onclick = async (e) => {
          const b = e.target.closest("[data-pick]");
          if (!b) return;
          b.disabled = true;
          try {
            await api(`trips/${t.id}/seats`, { method: "POST", body: { requestId: b.dataset.pick }, token: mine[t.id] });
            toast("Added to your car");
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
    const lines = [`*${C.eventName}: rides*`, ""];
    for (const leg of legs) {
      const trips = data.trips.filter((t) => t.leg === leg.id).sort(byTime);
      const reqs = data.requests.filter((r) => r.leg === leg.id);
      lines.push(`*${legDay(leg)}, ${legDir(leg)}*`);
      if (!trips.length) lines.push("No cars yet");
      for (const t of trips) {
        const free = t.seats - t.passengers.length;
        const where = isBack(leg) ? `drop-off ${t.pickup}` : `from ${t.pickup}`;
        lines.push(`• ${t.time ? timeText(t) : "time TBD"} ${t.driver}, ${where}: ${free > 0 ? `${free} free` : "full"} (${t.passengers.length}/${t.seats})`);
      }
      if (reqs.length) lines.push(`Still looking: ${reqs.map((r) => r.name).join(", ")}`);
      lines.push("");
    }
    lines.push(`Add your car or grab a seat: ${location.origin}`);
    return lines.join("\n");
  }

  async function copySummary() {
    const textOut = summaryText();
    try {
      await navigator.clipboard.writeText(textOut);
      toast("Summary copied. Paste it in the group.");
    } catch {
      openDialog({
        title: "Summary for WhatsApp",
        body: `<textarea class="summary-box" id="f-summary" readonly>${esc(textOut)}</textarea><p class="dlg-lead">Copy this and paste it in the group.</p>`,
        cancel: "Close",
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
      title: "Organizer mode",
      submit: "Unlock",
      body: `<p class="dlg-lead">Lets you edit or remove any ride or entry. Enter the organizer key you set when deploying.</p>
        <label class="field"><span>Organizer key</span><input id="f-admin" name="key" type="password" required autocomplete="off"></label>`,
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
        toast("Organizer mode on");
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

  $("#legs").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-leg]");
    if (!chip) return;
    filter = chip.dataset.leg;
    store.set("gt.filter", filter);
    render();
  });

  const onAct = (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || !data) return;
    const { act, trip: tripId, pax: paxId, req: reqId } = b.dataset;
    const trip = tripId && data.trips.find((t) => t.id === tripId);

    if (act === "drive") return driveForm(null, b.dataset.leg);
    if (act === "take") return takeSeat(tripId);
    if (act === "add-someone") return addPicker(tripId);
    if (act === "edit-trip" && trip) return driveForm(trip);

    if (act === "cancel-trip" && trip) {
      const n = trip.passengers.length;
      return confirmBox(
        "Cancel this ride?",
        n ? `${plural(n, "person goes", "people go")} back on the Still looking list. Let them know in the group.` : "It disappears from the board.",
        "Cancel ride",
        async () => {
          await api(`trips/${trip.id}`, { method: "DELETE", token: mine[trip.id] });
          toast("Ride cancelled");
        }
      );
    }
    if (act === "leave" && trip) {
      return confirmBox("Give up your seat?", `Your seat in ${esc(trip.driver)}'s car opens up for someone else.`, "Give up seat", async () => {
        await api(`trips/${trip.id}/seats/${paxId}`, { method: "DELETE", token: mine[paxId] });
        toast("Seat freed");
      });
    }
    if (act === "remove-pax" && trip) {
      const p = trip.passengers.find((x) => x.id === paxId);
      return confirmBox("Remove passenger?", `${esc(p ? p.name : "They")} goes back on the Still looking list.`, "Remove", async () => {
        await api(`trips/${trip.id}/seats/${paxId}`, { method: "DELETE", token: mine[trip.id] });
        toast("Passenger removed");
      });
    }
    if (act === "pick" && trip) {
      const r = data.requests.find((x) => x.id === reqId);
      return confirmBox("Add to your car?", `${esc(r ? r.name : "They")} gets a seat in your car. Message them to agree where to meet.`, "Add to my car", async () => {
        await api(`trips/${trip.id}/seats`, { method: "POST", body: { requestId: reqId }, token: mine[trip.id] });
        toast("Added to your car");
      });
    }
    if (act === "del-req") {
      const own = isMine(reqId);
      return confirmBox(own ? "Remove yourself from the list?" : "Remove this entry?", own ? "Do this once you've sorted a ride." : "They disappear from Still looking.", "Remove", async () => {
        await api(`requests/${reqId}`, { method: "DELETE", token: mine[reqId] });
        toast("Removed from the list");
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

  // ---------- boot ----------
  document.title = C.eventName;
  $("#event-name").textContent = C.eventName;
  $("#tagline").textContent = C.tagline || "";
  $("#venue-note").textContent = C.venueNote || "";
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
