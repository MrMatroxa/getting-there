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

console.log("All carpool tests passed.");
