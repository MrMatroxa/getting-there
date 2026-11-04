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

  function route(trip) {
    const leg = legById[trip.leg];
    const there = C.destinationShort;
    const arrow = '<span class="arrow" aria-hidden="true">→</span>';
    if (leg && leg.direction === "from") return `${esc(there)} ${arrow} ${esc(trip.pickup)}`;
    return `${esc(trip.pickup)} ${arrow} ${esc(there)}`;
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
  const byTime = (a, b) => a.time.localeCompare(b.time) || a.createdAt - b.createdAt;

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
      if (isMine(t.id)) {
        rows.push(
          `<li><span class="what">You're driving · ${t.passengers.length}/${t.seats} seats taken</span><span class="when">${esc(leg ? legName(leg) : t.leg)} ${esc(t.time)}</span></li>`
        );
      }
      for (const p of t.passengers) {
        if (isMine(p.id)) {
          rows.push(
            `<li><span class="what">Seat in ${esc(t.driver)}'s car</span><span class="when">${esc(leg ? legName(leg) : t.leg)} ${esc(t.time)} · ${esc(t.pickup)}</span></li>`
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

    const pax = t.passengers
      .map((p) => {
        const mineP = isMine(p.id);
        const removable = canManage && !mineP;
        return `<li class="${mineP ? "me" : ""}">${esc(p.name)}${mineP ? " (you)" : ""}${
          removable ? `<button type="button" data-act="remove-pax" data-trip="${esc(t.id)}" data-pax="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">×</button>` : ""
        }</li>`;
      })
      .join("");

    const actions = [];
    if (mySeat) {
      actions.push(`<button type="button" class="link danger" data-act="leave" data-trip="${esc(t.id)}" data-pax="${esc(mySeat.id)}">Give up my seat</button>`);
    } else if (!driver && free > 0) {
      actions.push(`<button type="button" class="btn small primary" data-act="take" data-trip="${esc(t.id)}">Take a seat</button>`);
    }
    if (canManage) {
      actions.push(`<button type="button" class="link" data-act="edit-trip" data-trip="${esc(t.id)}">Edit ride</button>`);
      actions.push(`<button type="button" class="link danger" data-act="cancel-trip" data-trip="${esc(t.id)}">Cancel ride</button>`);
    }

    return `<article class="trip${free <= 0 ? " full" : ""}${driver ? " is-mine" : ""}">
      <div class="trip-time"><span class="t">${esc(t.time)}</span><span class="d">${esc(leg ? dayShort(leg) : "")}</span></div>
      <div class="trip-main">
        <div class="route">${route(t)}</div>
        <div class="who"><span class="role">Driver</span><span class="name">${esc(t.driver)}${driver ? " (you)" : ""}</span>${contactHtml(t.contact)}</div>
        <div class="seatline">
          <span class="dots" aria-hidden="true">${dots}</span>
          <span class="seat-text${free > 0 ? " free" : ""}">${free > 0 ? `${free} of ${t.seats} free` : "Full"}</span>
          <span class="trunk">${esc(TRUNK[t.luggage] || "")}</span>
        </div>
        ${pax ? `<ul class="pax" aria-label="Passengers">${pax}</ul>` : ""}
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
        <div class="req-top"><span class="name">${esc(r.name)}</span>${r.pickup ? `<span class="from">${leg.direction === "to" ? "from" : "to"} ${esc(r.pickup)}</span>` : ""}</div>
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
  const pickupOptions = (selected) => {
    const known = C.pickupPoints.includes(selected);
    const opts = C.pickupPoints.map((p) => `<option ${p === selected ? "selected" : ""}>${esc(p)}</option>`).join("");
    return `${opts}<option value="__other" ${selected && !known ? "selected" : ""}>Somewhere else…</option>`;
  };
  function pickupField(selected = "", label = "Meeting point in the city", required = true) {
    const known = !selected || C.pickupPoints.includes(selected);
    return `<label class="field"><span>${esc(label)}</span>
        <select id="f-pickup" name="pickup" ${required ? "required" : ""}>
          ${required ? "" : `<option value="" ${!selected ? "selected" : ""}>Anywhere is fine</option>`}
          ${pickupOptions(selected || (required ? C.pickupPoints[0] : ""))}
        </select></label>
      <label class="field" id="f-other-wrap" ${known ? "hidden" : ""}><span>Where exactly?</span>
        <input id="f-pickup-other" name="pickupOther" maxlength="60" value="${known ? "" : esc(selected)}" placeholder="e.g. Rimi on Brīvības iela"></label>`;
  }
  function wirePickup(root) {
    const sel = $("#f-pickup", root);
    const wrap = $("#f-other-wrap", root);
    const other = $("#f-pickup-other", root);
    const sync = () => {
      const on = sel.value === "__other";
      wrap.hidden = !on;
      other.required = on;
    };
    sel.addEventListener("change", () => {
      sync();
      if (sel.value === "__other") other.focus();
    });
    sync();
  }
  const readPickup = (fd) => (fd.get("pickup") === "__other" ? String(fd.get("pickupOther") || "").trim() : String(fd.get("pickup") || ""));

  const personFields = (name, contact, nameLabel = "Your name") => `
    <div class="row2">
      <label class="field"><span>${esc(nameLabel)}</span><input id="f-name" name="name" required maxlength="40" autocomplete="name" value="${esc(name)}"></label>
      <label class="field"><span>WhatsApp number</span><input id="f-contact" name="contact" required maxlength="40" inputmode="tel" autocomplete="tel" value="${esc(contact)}" placeholder="+371 2…"></label>
    </div>`;

  // ---------- flows ----------
  function driveForm(trip, presetLeg, prefill) {
    const editing = !!trip;
    const v = trip || {
      leg: presetLeg || (filter !== "all" ? filter : legs[0].id),
      time: "",
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
          <label class="field"><span>Leaving at</span><input id="f-time" type="time" name="time" required value="${esc(v.time)}"></label>
          <div class="field"><span>Free seats</span>
            <div class="stepper"><button type="button" data-step="-1" aria-label="Fewer seats">−</button><output id="f-seats-out">${v.seats}</output><button type="button" data-step="1" aria-label="More seats">+</button></div>
            <input type="hidden" name="seats" id="f-seats" value="${v.seats}">
            <small>Not counting you.</small>
          </div>
        </div>
        ${pickupField(v.pickup, "Meeting point in the city")}
        <fieldset class="fieldset"><legend>Trunk space</legend><div class="choices">${trunk}</div></fieldset>
        ${personFields(v.driver, v.contact)}
        <label class="field"><span>Note <small>(optional)</small></span><textarea id="f-note" name="note" maxlength="280" placeholder="e.g. Can pick up anywhere along the way, bringing the speakers">${esc(v.note)}</textarea></label>`,
      onOpen(root) {
        wirePickup(root);
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
          time: fd.get("time"),
          seats: Number(fd.get("seats")),
          pickup: readPickup(fd),
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
              driveForm(null, back.id, { seats: body.seats, luggage: body.luggage, pickup: body.pickup, note: "" });
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
    openDialog({
      title: "I need a ride",
      submit: "Add me to the list",
      body: `
        <p class="dlg-lead">You'll show up under <strong>Still looking</strong> so drivers can add you. You can also just pick a car with free seats.</p>
        <fieldset class="fieldset"><legend>Which trips?</legend><div class="choices">${choices}</div><small>Pick every trip you still need. ✓ = already sorted or listed.</small></fieldset>
        ${pickupField("", "Best meeting point for you", false)}
        ${personFields(me.name, me.contact)}
        <label class="field"><span>Note <small>(optional)</small></span><textarea id="f-note" name="note" maxlength="200" placeholder="e.g. Big bag + sleeping bag, flexible on time"></textarea></label>`,
      onOpen: wirePickup,
      async onSubmit(fd) {
        const chosen = fd.getAll("legs");
        if (!chosen.length) throw new Error("Pick at least one trip.");
        const base = {
          name: String(fd.get("name")).trim(),
          contact: String(fd.get("contact")).trim(),
          pickup: readPickup(fd),
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
    const myReq = data.requests.find((r) => r.leg === t.leg && isMine(r.id));
    const already = data.trips.find((x) => x.leg === t.leg && x.passengers.some((p) => isMine(p.id)));
    openDialog({
      title: "Take a seat",
      submit: "Take the seat",
      body: `
        <p class="dlg-lead"><strong>${esc(t.driver)}</strong> · ${esc(leg ? legName(leg) : "")} at <strong>${esc(t.time)}</strong> · ${route(t)}</p>
        ${already ? `<p class="form-error" style="margin:0">You already have a seat in ${esc(already.driver)}'s car for this trip. Give that one up first if you're switching.</p>` : ""}
        ${myReq ? `<p class="dlg-lead">You'll come off the Still looking list.</p>` : personFields(me.name, me.contact)}
        <p class="dlg-lead">Message ${esc(t.driver)} on WhatsApp to agree where exactly to meet.</p>`,
      async onSubmit(fd) {
        if (myReq) {
          await api(`trips/${t.id}/seats`, { method: "POST", body: { requestId: myReq.id }, token: mine[myReq.id] });
        } else {
          const body = { name: String(fd.get("name")).trim(), contact: String(fd.get("contact")).trim() };
          rememberMe(body.name, body.contact);
          const res = await api(`trips/${t.id}/seats`, { method: "POST", body });
          remember(res.id, res.token);
        }
        toast(`You're in ${t.driver}'s car`);
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
        const where = leg.direction === "to" ? `from ${t.pickup}` : `to ${t.pickup}`;
        lines.push(`• ${t.time} ${t.driver}, ${where}: ${free > 0 ? `${free} free` : "full"} (${t.passengers.length}/${t.seats})`);
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

  $("#board").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || !data) return;
    const { act, trip: tripId, pax: paxId, req: reqId } = b.dataset;
    const trip = tripId && data.trips.find((t) => t.id === tripId);

    if (act === "drive") return driveForm(null, b.dataset.leg);
    if (act === "take") return takeSeat(tripId);
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
  });

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
