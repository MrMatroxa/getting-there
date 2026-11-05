// Plain Node test of the carpool logic (no Cloudflare needed): node test/board.test.js
import assert from "node:assert/strict";
import { handleApi, emptyState } from "../src/board.js";

const env = { EVENT_CODE: "letsgo", ADMIN_KEY: "boss" };
const state = emptyState();

async function call(method, path, { body, token, admin, code = "letsgo" } = {}) {
  const headers = { "content-type": "application/json" };
  if (code) headers["x-event-code"] = code;
  if (token) headers["x-token"] = token;
  if (admin) headers["x-admin-key"] = admin;
  const req = new Request("https://x.test/api/" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const { response } = await handleApi(req, state, env);
  return { status: response.status, body: await response.json() };
}

let r;

// event code
r = await call("GET", "state", { code: "" });
assert.equal(r.status, 401);
r = await call("GET", "state", { code: "LETSGO" });
assert.equal(r.status, 200, "code is case-insensitive");

// driver posts a ride with 2 seats
r = await call("POST", "trips", { body: { leg: "fri-to", time: "18:30", seats: 2, pickup: "Central Station", driver: "Jānis", contact: "29123456" } });
assert.equal(r.status, 200);
const trip = r.body;
assert.ok(trip.token);
assert.equal(r.body.state.trips[0].token, undefined, "tokens never leak");

// bad input
r = await call("POST", "trips", { body: { leg: "fri-to", time: "25:00", seats: 2, pickup: "x", driver: "a", contact: "1" } });
assert.equal(r.status, 400);

// rider takes a seat directly
r = await call("POST", `trips/${trip.id}/seats`, { body: { name: "Anna", contact: "+37120000000" } });
assert.equal(r.status, 200);
const anna = r.body;

// someone posts "need a ride", then moves into the car with their own token
r = await call("POST", "requests", { body: { leg: "fri-to", name: "Pēteris", contact: "20000001" } });
const pet = r.body;
r = await call("POST", `trips/${trip.id}/seats`, { body: { requestId: pet.id }, token: pet.token });
assert.equal(r.status, 200);
assert.equal(r.body.state.requests.length, 0);
assert.equal(r.body.state.trips[0].passengers.length, 2);

// car is now full
r = await call("POST", `trips/${trip.id}/seats`, { body: { name: "Late", contact: "20000002" } });
assert.equal(r.status, 409);

// can't lower seats below passengers
r = await call("PATCH", `trips/${trip.id}`, { body: { seats: 1 }, token: trip.token });
assert.equal(r.status, 409);

// a stranger can't remove Anna; Anna can leave herself
r = await call("DELETE", `trips/${trip.id}/seats/${anna.id}`, { token: "nope" });
assert.equal(r.status, 403);
r = await call("DELETE", `trips/${trip.id}/seats/${anna.id}`, { token: anna.token });
assert.equal(r.status, 200);
assert.equal(r.body.state.requests.length, 0, "leaving yourself doesn't relist you");

// driver removes Pēteris -> he goes back to the looking list, still his
r = await call("DELETE", `trips/${trip.id}/seats/${pet.id}`, { token: trip.token });
assert.equal(r.body.state.requests.length, 1);
assert.equal(r.body.state.requests[0].id, pet.id);

// driver picks him again from the list
r = await call("POST", `trips/${trip.id}/seats`, { body: { requestId: pet.id }, token: trip.token });
assert.equal(r.status, 200);

// wrong-day pick is refused
r = await call("POST", "requests", { body: { leg: "sun-from", name: "Sunday Sam", contact: "20000003" } });
const sam = r.body;
r = await call("POST", `trips/${trip.id}/seats`, { body: { requestId: sam.id }, token: trip.token });
assert.equal(r.status, 409);

// only the owner or organizer removes a request
r = await call("DELETE", `requests/${sam.id}`, { token: trip.token });
assert.equal(r.status, 403);
r = await call("DELETE", `requests/${sam.id}`, { admin: "boss" });
assert.equal(r.status, 200);

// organizer key check
assert.equal((await call("GET", "admin", { admin: "wrong" })).status, 403);
assert.equal((await call("GET", "admin", { admin: "boss" })).status, 200);

// cancelling the ride puts passengers back on the list
r = await call("DELETE", `trips/${trip.id}`, { token: trip.token });
assert.equal(r.body.state.trips.length, 0);
assert.deepEqual(r.body.state.requests.map((x) => x.name), ["Pēteris"]);

// flexible return trip: time may be empty, but only when flagged flexible
r = await call("POST", "trips", { body: { leg: "sun-from", time: "", seats: 2, pickup: "Brīvības 99", driver: "Mat", contact: "29000000" } });
assert.equal(r.status, 400, "empty time needs flexible");
r = await call("POST", "trips", { body: { leg: "sun-from", time: "", flexible: true, seats: 2, pickup: "Brīvības 99", driver: "Mat", contact: "29000000" } });
assert.equal(r.status, 200);
const back = r.body;
assert.equal(r.body.state.trips.find((t) => t.id === back.id).time, "");
r = await call("PATCH", `trips/${back.id}`, { body: { time: "16:30" }, token: back.token });
assert.equal(r.body.state.trips.find((t) => t.id === back.id).time, "16:30");

// a request's area, address and time follow the person into the car and back out
r = await call("POST", "requests", { body: { leg: "sun-from", name: "Andris", contact: "20000009", area: "Pļavnieki", pickup: "Spice", time: "15:00" } });
const andris = r.body;
r = await call("POST", `trips/${back.id}/seats`, { body: { requestId: andris.id }, token: back.token });
const pax = r.body.state.trips.find((t) => t.id === back.id).passengers[0];
assert.deepEqual([pax.area, pax.pickup, pax.time], ["Pļavnieki", "Spice", "15:00"]);
r = await call("DELETE", `trips/${back.id}/seats/${andris.id}`, { token: back.token });
const relisted = r.body.state.requests.find((x) => x.id === andris.id);
assert.deepEqual([relisted.area, relisted.pickup, relisted.time], ["Pļavnieki", "Spice", "15:00"]);
await call("DELETE", `requests/${andris.id}`, { admin: "boss" });
await call("DELETE", `trips/${back.id}`, { token: back.token });

// groups: a request for 2 takes 2 seats, and won't fit where only 1 is free
r = await call("POST", "trips", { body: { leg: "sat-to", time: "10:00", seats: 3, pickup: "Origo", driver: "G", contact: "29000010" } });
const gTrip = r.body;
r = await call("POST", "requests", { body: { leg: "sat-to", name: "Florence", contact: "+41770000000", count: 2 } });
const flo = r.body;
assert.equal(r.body.state.requests.find((x) => x.id === flo.id).count, 2);
r = await call("POST", `trips/${gTrip.id}/seats`, { body: { name: "Solo", contact: "29000011" } });
const solo = r.body;
r = await call("POST", `trips/${gTrip.id}/seats`, { body: { name: "Duo", contact: "29000012", count: 3 } });
assert.equal(r.status, 409, "a group of 3 doesn't fit in 2 free seats");
r = await call("POST", `trips/${gTrip.id}/seats`, { body: { requestId: flo.id }, token: gTrip.token });
assert.equal(r.status, 200, "group of 2 fits the last 2 seats");
r = await call("POST", `trips/${gTrip.id}/seats`, { body: { name: "Late", contact: "29000013" } });
assert.equal(r.status, 409, "car is full: 1 + 2 = 3");
r = await call("PATCH", `trips/${gTrip.id}`, { body: { seats: 2 }, token: gTrip.token });
assert.equal(r.status, 409, "can't drop below 3 used seats");
// removed group goes back on the list as a group
r = await call("DELETE", `trips/${gTrip.id}/seats/${flo.id}`, { token: gTrip.token });
assert.equal(r.body.state.requests.find((x) => x.id === flo.id).count, 2);

// the organizer (or the owner) can change an entry's group size; strangers can't
r = await call("PATCH", `requests/${flo.id}`, { body: { count: 3 }, token: "nope" });
assert.equal(r.status, 403);
r = await call("PATCH", `requests/${flo.id}`, { body: { count: 3 }, admin: "boss" });
assert.equal(r.body.state.requests.find((x) => x.id === flo.id).count, 3);
r = await call("PATCH", `requests/${flo.id}`, { body: { count: 0 }, token: flo.token });
assert.equal(r.status, 400);
r = await call("PATCH", `requests/${flo.id}`, { body: { count: 1, note: "Jasmine found another ride" }, token: flo.token });
assert.equal(r.body.state.requests.find((x) => x.id === flo.id).note, "Jasmine found another ride");
await call("DELETE", `requests/${flo.id}`, { admin: "boss" });
await call("DELETE", `trips/${gTrip.id}/seats/${solo.id}`, { token: solo.token });
await call("DELETE", `trips/${gTrip.id}`, { token: gTrip.token });

// posting a ride can take people from the looking list in the same step
r = await call("POST", "requests", { body: { leg: "fri-to", name: "Flo", contact: "+41770000001", count: 2 } });
const flo2 = r.body;
r = await call("POST", "requests", { body: { leg: "fri-to", name: "Tom", contact: "+37256700001" } });
const tom = r.body;
r = await call("POST", "requests", { body: { leg: "sun-from", name: "SunOnly", contact: "29000020" } });
const sunOnly = r.body;
r = await call("POST", "trips", {
  body: { leg: "fri-to", time: "18:00", seats: 2, pickup: "Origo", driver: "Ri", contact: "29000021", take: [flo2.id, tom.id, sunOnly.id, "gone"] },
});
assert.equal(r.status, 200);
let posted = r.body.state.trips.find((x) => x.id === r.body.id);
assert.deepEqual(posted.passengers.map((p) => [p.name, p.count]), [["Flo", 2]], "Flo's group of 2 fills both seats");
assert.deepEqual(r.body.skipped, [tom.id, sunOnly.id, "gone"], "no room for Tom, wrong day, and missing ids are skipped");
assert.ok(!r.body.state.requests.some((x) => x.id === flo2.id), "Flo is off the looking list");
assert.ok(r.body.state.requests.some((x) => x.id === tom.id), "Tom is still looking");
const riTrip = r.body;
await call("DELETE", `trips/${riTrip.id}`, { token: riTrip.token });
for (const id of [flo2.id, tom.id, sunOnly.id]) await call("DELETE", `requests/${id}`, { admin: "boss" });

console.log("All carpool tests passed.");
