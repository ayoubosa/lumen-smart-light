/* ════════════════════════════════════
   LUMEN STATE ENGINE
   The lighting rules in one place. Used by the browser demo mode
   (js/device.js) and by the mock controller (tools/mock-device.cjs).
   The ESP32 firmware applies the same rules in C++ (firmware/src/lights.cpp),
   so if a rule changes here, change it there too.
   ════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LumenEngine = api;
})(typeof self !== "undefined" ? self : this, function () {

  const ROOM_IDS = ["living", "bedroom", "kitchen", "bathroom", "hallway", "garage"];

  /* Same defaults as firmware/include/config.h */
  const DEFAULTS = {
    defaultOnBrightness: 50,   // brightness used when a room is switched on for the first time
    entryBrightness: 70,       // brightness used when motion switches a room on
    darkThreshold: 30,         // ambient light % below which entry lighting is allowed
    autoOffSeconds: 300,       // motion-lit rooms switch off after this much stillness (0 = never)
    hardware: {                // what is wired to each room on the reference board
      living: "pwm",
      bedroom: "relay",
      kitchen: "relay",
      bathroom: "none",
      hallway: "none",
      garage: "none"
    }
  };

  function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
  }

  function clampBrightness(v) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  const present = v => v !== undefined && v !== null;   // JSON null counts as "not sent", as in the firmware

  /* Pure rule: apply a {on} or {brightness} patch to one room.
     brightness wins over on; brightness 0 means off; switching on restores
     the last non-zero brightness. */
  function applyPatch(room, patch, defaultOnBrightness) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw httpError(400, "Body must be a JSON object");
    if (present(patch.brightness)) {
      const b = clampBrightness(patch.brightness);
      if (b === null) throw httpError(400, "brightness must be a number from 0 to 100");
      room.brightness = b;
      room.on = b > 0;
    } else if (present(patch.on)) {
      if (typeof patch.on !== "boolean") throw httpError(400, "on must be true or false");
      room.on = patch.on;
      room.brightness = patch.on ? (room.brightness || room.last || defaultOnBrightness || 50) : 0;
    } else {
      throw httpError(400, "Send on or brightness");
    }
    if (room.brightness > 0) room.last = room.brightness;
    room.auto = false;
    return room;
  }

  function createEngine(options) {
    // options left undefined keep their default (Object.assign would copy the undefined)
    const given = Object.fromEntries(Object.entries(options || {}).filter(([, v]) => v !== undefined));
    const cfg = Object.assign({}, DEFAULTS, given);
    cfg.hardware = Object.assign({}, DEFAULTS.hardware, (options && options.hardware) || {});
    const now = cfg.now || (() => Date.now());
    const listeners = new Set();

    const rooms = {};
    ROOM_IDS.forEach(id => {
      rooms[id] = { on: false, brightness: 0, last: cfg.defaultOnBrightness, auto: false, hw: cfg.hardware[id] || "none" };
    });
    let entryRooms = [];
    let mode = "auto";   // "auto": motion lighting runs; "manual": only people switch lights
    const sensors = { motion: false, lastMotionAt: null, light: null };

    function isDark() {
      return sensors.light === null || sensors.light < cfg.darkThreshold;
    }

    function emit(reason) {
      listeners.forEach(fn => fn(reason));
    }

    function getRoom(id) {
      const room = rooms[id];
      if (!room) throw httpError(404, "Unknown room: " + id);
      return room;
    }

    function roomSnapshot(id) {
      const r = rooms[id];
      return { on: r.on, brightness: r.brightness, hw: r.hw, auto: r.auto };
    }

    function snapshot() {
      const out = {
        mode,
        rules: { entryBrightness: cfg.entryBrightness, autoOffSeconds: cfg.autoOffSeconds, darkThreshold: cfg.darkThreshold },
        rooms: {},
        entryRooms: entryRooms.slice(),
        sensors: {}
      };
      ROOM_IDS.forEach(id => { out.rooms[id] = roomSnapshot(id); });
      out.sensors = {
        motion: sensors.motion,
        lastMotionAgo: sensors.lastMotionAt === null ? null : Math.round((now() - sensors.lastMotionAt) / 1000),
        light: sensors.light,
        dark: isDark()
      };
      return out;
    }

    function setRoom(id, patch) {
      applyPatch(getRoom(id), patch, cfg.defaultOnBrightness);
      emit("room");
      return roomSnapshot(id);
    }

    function setEntryRooms(list) {
      if (!Array.isArray(list)) throw httpError(400, "rooms must be an array of room ids");
      const clean = [];
      list.forEach(id => {
        if (!rooms[id]) throw httpError(400, "Unknown room: " + id);
        if (!clean.includes(id)) clean.push(id);
      });
      entryRooms = clean;
      emit("entry");
      return entryRooms.slice();
    }

    /* Auto/Manual, like the original app. Going to manual hands any
       motion-lit room over to the user, so auto-off will not touch it. */
    function setMode(next) {
      if (next !== "auto" && next !== "manual") throw httpError(400, "mode must be \"auto\" or \"manual\"");
      mode = next;
      if (mode === "manual") ROOM_IDS.forEach(id => { rooms[id].auto = false; });
      emit("mode");
      return mode;
    }

    /* PIR edge. In auto mode a rising edge switches entry rooms on when it is dark.
       Motion is still reported in manual mode. */
    function setMotion(active) {
      active = !!active;
      const turnedOn = [];
      sensors.lastMotionAt = now();   // on both edges: auto-off counts from when movement stopped
      if (active) {
        if (mode === "auto" && isDark()) {
          entryRooms.forEach(id => {
            const r = rooms[id];
            if (!r.on) {
              r.on = true;
              r.brightness = cfg.entryBrightness;
              r.last = cfg.entryBrightness;
              r.auto = true;
              turnedOn.push(id);
            }
          });
        }
      }
      if (active !== sensors.motion || turnedOn.length) {
        sensors.motion = active;
        emit("motion");
      }
      return turnedOn;
    }

    function setLight(percent) {
      const v = percent === null ? null : clampBrightness(Number(percent));
      sensors.light = v;
      emit("light");
    }

    /* Call every few seconds: switches off rooms that motion turned on
       once nobody has moved for autoOffSeconds. */
    function tick() {
      if (mode !== "auto" || !cfg.autoOffSeconds || sensors.motion || sensors.lastMotionAt === null) return [];
      if (now() - sensors.lastMotionAt < cfg.autoOffSeconds * 1000) return [];
      const turnedOff = [];
      ROOM_IDS.forEach(id => {
        const r = rooms[id];
        if (r.auto && r.on) {
          r.on = false;
          r.brightness = 0;
          r.auto = false;
          turnedOff.push(id);
        }
      });
      if (turnedOff.length) emit("auto-off");
      return turnedOff;
    }

    /* Restore a saved snapshot (demo mode keeps one in localStorage). */
    function load(saved) {
      if (!saved || typeof saved !== "object") return;
      if (saved.rooms) {
        ROOM_IDS.forEach(id => {
          const s = saved.rooms[id];
          if (!s) return;
          const b = clampBrightness(s.on ? Number(s.brightness) : 0);
          rooms[id].brightness = b || 0;
          rooms[id].on = rooms[id].brightness > 0;
          if (rooms[id].brightness > 0) rooms[id].last = rooms[id].brightness;
        });
      }
      if (Array.isArray(saved.entryRooms)) entryRooms = saved.entryRooms.filter(id => rooms[id]);
      if (saved.mode === "auto" || saved.mode === "manual") mode = saved.mode;
    }

    function onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    return { snapshot, setRoom, setEntryRooms, setMode, setMotion, setLight, tick, load, onChange };
  }

  return { ROOM_IDS, DEFAULTS, applyPatch, createEngine };
});
