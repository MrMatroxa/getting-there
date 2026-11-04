// All carpool logic lives here, independent of Cloudflare, so it can be tested
// with plain Node. `handleApi` takes the stored state and a request and returns
// the response plus the (possibly) changed state.

const MAX_ITEMS = 500; // trips + requests, a guard against spam
const MAX_SEATS = 8;
const LUGGAGE = ["roomy", "normal", "tight"];

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function emptyState() {
  return { trips: [], requests: [] };
}

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const newToken = () => crypto.randomUUID();

// Latvian versions of every error message, picked when the page sends x-lang: lv.
const LV_LABELS = {
  Name: "Vārds",
  "WhatsApp number": "WhatsApp numurs",
  Day: "Diena",
  Time: "Laiks",
  Note: "Piezīme",
  Address: "Adrese",
  "Pickup spot": "Satikšanās vieta",
  Area: "Rajons",
  "Trunk space": "Bagāžnieks",
};
const LV_FIXED = {
  "Time should look like 18:30.": "Laikam jāizskatās šādi: 18:30.",
  "That event code isn't right.": "Pasākuma kods nav pareizs.",
  "Enter the event code to continue.": "Ievadi pasākuma kodu, lai turpinātu.",
  "No organizer key is set on the server yet.": "Serverī vēl nav iestatīta organizatora atslēga.",
  "That organizer key isn't right.": "Organizatora atslēga nav pareiza.",
  "The board is full. Ask the organizer to tidy up.": "Saraksts ir pilns. Palūdz organizatoram to sakopt.",
  "That ride doesn't exist any more.": "Šis brauciens vairs nepastāv.",
  "Only the driver can change this ride.": "Šo braucienu var mainīt tikai šoferis.",
  "People already have seats on this ride, so the day can't change. Cancel it and add a new one instead.":
    "Šajā braucienā jau ir pasažieri, tāpēc dienu mainīt nevar. Atcel to un pievieno jaunu.",
  "Only the driver can cancel this ride.": "Šo braucienu var atcelt tikai šoferis.",
  "This car is already full.": "Šis auto jau ir pilns.",
  "That person isn't on the looking list any more.": "Šis cilvēks vairs nav meklētāju sarakstā.",
  "You can't move this person.": "Tu nevari pārvietot šo cilvēku.",
  "That person is looking for a ride on a different day.": "Šis cilvēks meklē braucienu citā dienā.",
  "That seat is already free.": "Šī vieta jau ir brīva.",
  "You can't change this seat.": "Tu nevari mainīt šo vietu.",
  "That entry is already gone.": "Šis ieraksts jau ir dzēsts.",
  "Only the person who posted this can remove it.": "To var dzēst tikai tas, kurš to pievienoja.",
  "The request couldn't be read.": "Pieprasījumu neizdevās nolasīt.",
  "Something went wrong on the server. Try again.": "Serverī kaut kas nogāja greizi. Mēģini vēlreiz.",
  "Not found.": "Nav atrasts.",
};
export function toLatvian(msg) {
  if (LV_FIXED[msg]) return LV_FIXED[msg];
  let m;
  const label = (l) => LV_LABELS[l] || l;
  if ((m = msg.match(/^(.+) looks wrong\.$/))) return `${label(m[1])}: nepareiza vērtība.`;
  if ((m = msg.match(/^(.+) is required\.$/))) return `${label(m[1])}: obligāti jāaizpilda.`;
  if ((m = msg.match(/^(.+) is too long \(max (\d+) characters\)\.$/))) return `${label(m[1])}: pārāk garš teksts (maks. ${m[2]} rakstzīmes).`;
  if ((m = msg.match(/^Free seats should be between 1 and (\d+)\.$/))) return `Brīvo vietu skaitam jābūt no 1 līdz ${m[1]}.`;
  if ((m = msg.match(/^(\d+) people already have a seat\./)))
    return `Vietas jau ir aizņēmuši ${m[1]} cilvēki. Vispirms kādu noņem, tad samazini vietu skaitu.`;
  return msg;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function text(value, label, max, { required = false } = {}) {
  if (value == null) value = "";
  if (typeof value !== "string" && typeof value !== "number") throw new HttpError(400, `${label} looks wrong.`);
  const v = String(value).trim().replace(/\s+/g, " ");
  if (required && !v) throw new HttpError(400, `${label} is required.`);
  if (v.length > max) throw new HttpError(400, `${label} is too long (max ${max} characters).`);
  return v;
}

function multiline(value, label, max) {
  if (value == null) return "";
  if (typeof value !== "string") throw new HttpError(400, `${label} looks wrong.`);
  const v = value.trim();
  if (v.length > max) throw new HttpError(400, `${label} is too long (max ${max} characters).`);
  return v;
}

function legId(value) {
  const v = text(value, "Day", 24, { required: true });
  if (!/^[a-z0-9-]+$/i.test(v)) throw new HttpError(400, "Day looks wrong.");
  return v;
}

function time(value) {
  const v = text(value, "Time", 5, { required: true });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new HttpError(400, "Time should look like 18:30.");
  return v;
}

// Time of day. Empty is fine when the driver or rider doesn't know yet.
function timeOptional(value) {
  if (value == null || String(value).trim() === "") return "";
  return time(value);
}

function seats(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SEATS) throw new HttpError(400, `Free seats should be between 1 and ${MAX_SEATS}.`);
  return n;
}

function luggage(value) {
  const v = value || "normal";
  if (!LUGGAGE.includes(v)) throw new HttpError(400, "Trunk space looks wrong.");
  return v;
}

function person(body) {
  return {
    name: text(body.name, "Name", 40, { required: true }),
    contact: text(body.contact, "WhatsApp number", 40, { required: true }),
  };
}

const PLACE_MAX = 100;

// What every visitor gets: tokens never leave the server.
export function publicState(s) {
  return {
    trips: s.trips.map(({ token, passengers, ...t }) => ({
      ...t,
      passengers: passengers.map(({ token: _t, ...p }) => p),
    })),
    requests: s.requests.map(({ token, ...r }) => r),
    serverTime: Date.now(),
  };
}

function itemCount(s) {
  return s.trips.length + s.requests.length;
}

async function readBody(request) {
  if (request.method !== "POST" && request.method !== "PATCH") return {};
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    throw new HttpError(400, "The request couldn't be read.");
  }
}

// A passenger who loses their seat (driver removed them or cancelled the
// ride) goes back on the "still looking" list with the same id and token, so
// their phone still recognises the entry as theirs.
function backToLooking(s, trip, p, why) {
  // why: "cancelled" | "removed"; the page words it in the reader's language.
  s.requests.push({
    id: p.id,
    token: p.token,
    leg: trip.leg,
    name: p.name,
    contact: p.contact,
    area: p.area || "",
    pickup: p.pickup || trip.pickup,
    time: p.time || "",
    note: p.note || "",
    relisted: { why, driver: trip.driver },
    createdAt: Date.now(),
  });
}

/**
 * @param {Request} request
 * @param {{trips: any[], requests: any[]}} state  mutable copy of stored state
 * @param {{EVENT_CODE?: string, ADMIN_KEY?: string}} env
 * @returns {Promise<{response: Response, changed: boolean}>}
 */
export async function handleApi(request, state, env) {
  try {
    return await route(request, state, env);
  } catch (e) {
    const lv = (request.headers.get("x-lang") || "") === "lv";
    const say = (msg) => (lv ? toLatvian(msg) : msg);
    if (e instanceof HttpError) return { response: json({ error: say(e.message) }, e.status), changed: false };
    console.error(e);
    return { response: json({ error: say("Something went wrong on the server. Try again.") }, 500), changed: false };
  }
}

async function route(request, s, env) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = request.method;

  if (env.EVENT_CODE) {
    const given = (request.headers.get("x-event-code") || "").trim().toLowerCase();
    if (given !== String(env.EVENT_CODE).trim().toLowerCase()) {
      throw new HttpError(401, given ? "That event code isn't right." : "Enter the event code to continue.");
    }
  }
  const isAdmin = !!env.ADMIN_KEY && request.headers.get("x-admin-key") === env.ADMIN_KEY;
  const token = request.headers.get("x-token") || "";
  const body = await readBody(request);
  const ok = (data = {}, changed = true) => ({ response: json({ ...data, state: publicState(s) }), changed });

  // GET /api/state
  if (parts[0] === "state" && method === "GET") {
    return { response: json(publicState(s)), changed: false };
  }

  // GET /api/admin  (checks the organizer key)
  if (parts[0] === "admin" && method === "GET") {
    if (!env.ADMIN_KEY) throw new HttpError(403, "No organizer key is set on the server yet.");
    if (!isAdmin) throw new HttpError(403, "That organizer key isn't right.");
    return { response: json({ ok: true }), changed: false };
  }

  if (parts[0] === "trips") {
    // POST /api/trips  -> offer a ride
    if (parts.length === 1 && method === "POST") {
      if (itemCount(s) >= MAX_ITEMS) throw new HttpError(429, "The board is full. Ask the organizer to tidy up.");
      const p = person({ name: body.driver, contact: body.contact });
      const flexible = !!body.flexible;
      const trip = {
        id: newId(),
        token: newToken(),
        leg: legId(body.leg),
        // flexible = "not sure yet": the time may be left empty or be a rough guess
        flexible,
        time: flexible ? timeOptional(body.time) : time(body.time),
        pickup: text(body.pickup, "Address", PLACE_MAX, { required: true }),
        seats: seats(body.seats),
        luggage: luggage(body.luggage),
        driver: p.name,
        contact: p.contact,
        note: multiline(body.note, "Note", 280),
        passengers: [],
        createdAt: Date.now(),
      };
      s.trips.push(trip);
      return ok({ id: trip.id, token: trip.token });
    }

    const trip = s.trips.find((t) => t.id === parts[1]);
    if (!trip) throw new HttpError(404, "That ride doesn't exist any more.");
    const isDriver = token && token === trip.token;

    // PATCH /api/trips/:id  -> driver edits their ride
    if (parts.length === 2 && method === "PATCH") {
      if (!isDriver && !isAdmin) throw new HttpError(403, "Only the driver can change this ride.");
      if ("flexible" in body) trip.flexible = !!body.flexible;
      if ("time" in body || "flexible" in body) {
        const t = "time" in body ? body.time : trip.time;
        trip.time = trip.flexible ? timeOptional(t) : time(t);
      }
      if ("pickup" in body) trip.pickup = text(body.pickup, "Address", PLACE_MAX, { required: true });
      if ("luggage" in body) trip.luggage = luggage(body.luggage);
      if ("note" in body) trip.note = multiline(body.note, "Note", 280);
      if ("driver" in body) trip.driver = text(body.driver, "Name", 40, { required: true });
      if ("contact" in body) trip.contact = text(body.contact, "WhatsApp number", 40, { required: true });
      if ("seats" in body) {
        const n = seats(body.seats);
        if (n < trip.passengers.length) {
          throw new HttpError(409, `${trip.passengers.length} people already have a seat. Remove someone first, then lower the seats.`);
        }
        trip.seats = n;
      }
      if ("leg" in body) {
        const leg = legId(body.leg);
        if (leg !== trip.leg && trip.passengers.length) {
          throw new HttpError(409, "People already have seats on this ride, so the day can't change. Cancel it and add a new one instead.");
        }
        trip.leg = leg;
      }
      return ok();
    }

    // DELETE /api/trips/:id  -> driver cancels; passengers go back to looking
    if (parts.length === 2 && method === "DELETE") {
      if (!isDriver && !isAdmin) throw new HttpError(403, "Only the driver can cancel this ride.");
      for (const p of trip.passengers) backToLooking(s, trip, p, "cancelled");
      s.trips = s.trips.filter((t) => t !== trip);
      return ok();
    }

    // POST /api/trips/:id/seats  -> take a seat
    // body {name, contact}                    a new passenger (returns their token)
    // body {requestId} + x-token of request   the rider moves their "looking" entry into the car
    // body {requestId} + x-token of the trip  the driver picks someone from the "looking" list
    if (parts[2] === "seats" && parts.length === 3 && method === "POST") {
      if (trip.passengers.length >= trip.seats) throw new HttpError(409, "This car is already full.");
      if (body.requestId) {
        const req = s.requests.find((r) => r.id === body.requestId);
        if (!req) throw new HttpError(404, "That person isn't on the looking list any more.");
        const byRider = token && token === req.token;
        if (!byRider && !isDriver && !isAdmin) throw new HttpError(403, "You can't move this person.");
        if (req.leg !== trip.leg) throw new HttpError(409, "That person is looking for a ride on a different day.");
        s.requests = s.requests.filter((r) => r !== req);
        trip.passengers.push({
          id: req.id,
          token: req.token,
          name: req.name,
          contact: req.contact,
          area: req.area || "",
          pickup: req.pickup || "",
          time: req.time || "",
          note: req.note || "",
          addedAt: Date.now(),
        });
        return ok({ id: req.id });
      }
      if (itemCount(s) >= MAX_ITEMS) throw new HttpError(429, "The board is full. Ask the organizer to tidy up.");
      const p = {
        id: newId(),
        token: newToken(),
        ...person(body),
        area: "",
        pickup: text(body.pickup, "Pickup spot", PLACE_MAX),
        time: "",
        note: "",
        addedAt: Date.now(),
      };
      trip.passengers.push(p);
      return ok({ id: p.id, token: p.token });
    }

    // DELETE /api/trips/:id/seats/:pid  -> passenger leaves, or driver removes them
    if (parts[2] === "seats" && parts.length === 4 && method === "DELETE") {
      const p = trip.passengers.find((x) => x.id === parts[3]);
      if (!p) throw new HttpError(404, "That seat is already free.");
      const isPassenger = token && token === p.token;
      if (!isPassenger && !isDriver && !isAdmin) throw new HttpError(403, "You can't change this seat.");
      trip.passengers = trip.passengers.filter((x) => x !== p);
      // Leaving yourself = gone. Removed by the driver = back on the looking list.
      if (!isPassenger) backToLooking(s, trip, p, "removed");
      return ok();
    }
  }

  if (parts[0] === "requests") {
    // POST /api/requests  -> "I need a ride"
    if (parts.length === 1 && method === "POST") {
      if (itemCount(s) >= MAX_ITEMS) throw new HttpError(429, "The board is full. Ask the organizer to tidy up.");
      const r = {
        id: newId(),
        token: newToken(),
        leg: legId(body.leg),
        ...person(body),
        area: text(body.area, "Area", 40),
        pickup: text(body.pickup, "Address", PLACE_MAX),
        time: timeOptional(body.time),
        note: multiline(body.note, "Note", 200),
        createdAt: Date.now(),
      };
      s.requests.push(r);
      return ok({ id: r.id, token: r.token });
    }

    // DELETE /api/requests/:id
    if (parts.length === 2 && method === "DELETE") {
      const r = s.requests.find((x) => x.id === parts[1]);
      if (!r) throw new HttpError(404, "That entry is already gone.");
      if (!(token && token === r.token) && !isAdmin) throw new HttpError(403, "Only the person who posted this can remove it.");
      s.requests = s.requests.filter((x) => x !== r);
      return ok();
    }
  }

  throw new HttpError(404, "Not found.");
}
