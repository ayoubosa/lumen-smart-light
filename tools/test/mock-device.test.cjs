"use strict";
/* Checks the HTTP contract in docs/API.md against the mock controller. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockDevice } = require("../mock-device.cjs");

async function start(options) {
  const { server } = createMockDevice(options);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  return { base, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

function put(base, path, body, headers) {
  return fetch(base + path, {
    method: "PUT",
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

test("GET /api/state has device, rooms, entryRooms and sensors", async (t) => {
  const d = await start();
  t.after(d.close);
  const res = await fetch(d.base + "/api/state");
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.device.hostname, "nather.local");
  assert.equal(s.device.simulated, true);
  assert.deepEqual(Object.keys(s.rooms), ["living", "bedroom", "kitchen", "bathroom", "hallway", "garage"]);
  assert.deepEqual(s.entryRooms, []);
  assert.equal(s.sensors.motion, false);
});

test("PUT /api/rooms/{id} updates a room and returns it", async (t) => {
  const d = await start();
  t.after(d.close);
  const res = await put(d.base, "/api/rooms/living", { brightness: 42 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { on: true, brightness: 42, hw: "pwm", auto: false });
  const s = await (await fetch(d.base + "/api/state")).json();
  assert.equal(s.rooms.living.brightness, 42);
});

test("bad requests get 400 / 404 with an error message", async (t) => {
  const d = await start();
  t.after(d.close);
  let res = await put(d.base, "/api/rooms/attic", { on: true });
  assert.equal(res.status, 404);
  res = await put(d.base, "/api/rooms/living", "{not json");
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /JSON/);
  res = await put(d.base, "/api/rooms/living", { colour: "red" });
  assert.equal(res.status, 400);
  res = await put(d.base, "/api/rooms/living", { brightness: 1, pad: "x".repeat(600) });
  assert.equal(res.status, 413);
});

test("PUT /api/entry-rooms + simulated motion switches rooms on", async (t) => {
  const d = await start();
  t.after(d.close);
  let res = await put(d.base, "/api/entry-rooms", { rooms: ["hallway"] });
  assert.deepEqual(await res.json(), { rooms: ["hallway"] });
  res = await fetch(d.base + "/api/sim/motion", { method: "POST" });
  assert.deepEqual(await res.json(), { turnedOn: ["hallway"] });
  const s = await (await fetch(d.base + "/api/state")).json();
  assert.equal(s.rooms.hallway.on, true);
  assert.equal(s.rooms.hallway.auto, true);
  assert.equal(s.sensors.motion, true);
});

test("writes need the token when one is set; reads stay open", async (t) => {
  const d = await start({ token: "s3cret" });
  t.after(d.close);
  assert.equal((await fetch(d.base + "/api/state")).status, 200);
  assert.equal((await put(d.base, "/api/rooms/living", { on: true })).status, 401);
  assert.equal((await put(d.base, "/api/rooms/living", { on: true }, { Authorization: "Bearer nope" })).status, 401);
  assert.equal((await put(d.base, "/api/rooms/living", { on: true }, { Authorization: "Bearer s3cret" })).status, 200);
});

test("GET /api/events pushes the state, then every change", async (t) => {
  const d = await start();
  t.after(d.close);
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const res = await fetch(d.base + "/api/events", { signal: ctrl.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function nextState() {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").find(l => l.startsWith("data: "));
        if (block.includes("event: state") && data) return JSON.parse(data.slice(6));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffer += decoder.decode(value, { stream: true });
    }
  }

  const first = await nextState();
  assert.equal(first.rooms.kitchen.on, false);
  await put(d.base, "/api/rooms/kitchen", { on: true });
  const second = await nextState();
  assert.equal(second.rooms.kitchen.on, true);
});

test("serves the website and refuses path traversal", async (t) => {
  const d = await start();
  t.after(d.close);
  const res = await fetch(d.base + "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Nather/);
  assert.equal((await fetch(d.base + "/js/device.js")).status, 200);
  const evil = await fetch(d.base + "/..%2f..%2fpackage.json");
  assert.notEqual(evil.status, 200);
});

test("CORS preflight is answered for cross-origin dashboards", async (t) => {
  const d = await start();
  t.after(d.close);
  const res = await fetch(d.base + "/api/rooms/living", { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.match(res.headers.get("access-control-allow-headers"), /Authorization/);
});
