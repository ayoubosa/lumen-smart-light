"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createEngine, applyPatch } = require("../../web/js/engine.js");

function clock(start) {
  let t = start || 1000000;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

test("brightness sets on/off and 0 means off", () => {
  const e = createEngine();
  assert.deepEqual(e.setRoom("living", { brightness: 40 }), { on: true, brightness: 40, hw: "pwm", auto: false });
  assert.equal(e.setRoom("living", { brightness: 0 }).on, false);
});

test("brightness is clamped and rounded", () => {
  const e = createEngine();
  assert.equal(e.setRoom("living", { brightness: 140 }).brightness, 100);
  assert.equal(e.setRoom("living", { brightness: -5 }).brightness, 0);
  assert.equal(e.setRoom("living", { brightness: 33.6 }).brightness, 34);
});

test("switching on restores the last brightness, first time uses the default", () => {
  const e = createEngine();
  assert.equal(e.setRoom("bedroom", { on: true }).brightness, 50);
  e.setRoom("bedroom", { brightness: 80 });
  e.setRoom("bedroom", { on: false });
  assert.equal(e.setRoom("bedroom", { on: true }).brightness, 80);
});

test("bad input is rejected with HTTP-style errors", () => {
  const e = createEngine();
  assert.throws(() => e.setRoom("attic", { on: true }), { status: 404 });
  assert.throws(() => e.setRoom("living", {}), { status: 400 });
  assert.throws(() => e.setRoom("living", { on: "yes" }), { status: 400 });
  assert.throws(() => e.setRoom("living", { brightness: "bright" }), { status: 400 });
  assert.throws(() => e.setEntryRooms("living"), { status: 400 });
  assert.throws(() => e.setEntryRooms(["attic"]), { status: 400 });
});

test("entry rooms are de-duplicated", () => {
  const e = createEngine();
  assert.deepEqual(e.setEntryRooms(["hallway", "living", "hallway"]), ["hallway", "living"]);
});

test("motion turns entry rooms on when dark, and not when bright", () => {
  const e = createEngine();
  e.setEntryRooms(["hallway", "living"]);
  e.setLight(80);
  assert.deepEqual(e.setMotion(true), []);
  e.setMotion(false);
  e.setLight(10);
  assert.deepEqual(e.setMotion(true), ["hallway", "living"]);
  const s = e.snapshot();
  assert.equal(s.rooms.hallway.brightness, 70);
  assert.equal(s.rooms.hallway.auto, true);
  assert.equal(s.sensors.dark, true);
});

test("no light sensor means it always counts as dark", () => {
  const e = createEngine();
  e.setEntryRooms(["garage"]);
  assert.deepEqual(e.setMotion(true), ["garage"]);
});

test("motion does not touch a room that is already on", () => {
  const e = createEngine();
  e.setEntryRooms(["living"]);
  e.setRoom("living", { brightness: 20 });
  assert.deepEqual(e.setMotion(true), []);
  assert.equal(e.snapshot().rooms.living.brightness, 20);
});

test("auto-off only switches off rooms that motion turned on", () => {
  const now = clock();
  const e = createEngine({ autoOffSeconds: 60, now });
  e.setEntryRooms(["hallway"]);
  e.setRoom("kitchen", { on: true });
  e.setMotion(true);
  e.setMotion(false);
  now.advance(59000);
  assert.deepEqual(e.tick(), []);
  now.advance(2000);
  assert.deepEqual(e.tick(), ["hallway"]);
  assert.equal(e.snapshot().rooms.kitchen.on, true);
});

test("touching a motion-lit room makes it manual, so auto-off leaves it", () => {
  const now = clock();
  const e = createEngine({ autoOffSeconds: 60, now });
  e.setEntryRooms(["hallway"]);
  e.setMotion(true);
  e.setMotion(false);
  e.setRoom("hallway", { brightness: 90 });
  now.advance(120000);
  assert.deepEqual(e.tick(), []);
});

test("auto-off waits while motion is still active", () => {
  const now = clock();
  const e = createEngine({ autoOffSeconds: 60, now });
  e.setEntryRooms(["hallway"]);
  e.setMotion(true);
  now.advance(120000);
  assert.deepEqual(e.tick(), []);
});

test("load restores saved rooms and ignores unknown ids", () => {
  const e = createEngine();
  e.load({ rooms: { living: { on: true, brightness: 65 }, attic: { on: true, brightness: 10 } }, entryRooms: ["living", "attic"] });
  const s = e.snapshot();
  assert.equal(s.rooms.living.brightness, 65);
  assert.deepEqual(s.entryRooms, ["living"]);
});

test("applyPatch is usable on its own for optimistic UI updates", () => {
  const room = { on: false, brightness: 0 };
  applyPatch(room, { on: true }, 50);
  assert.equal(room.brightness, 50);
});
