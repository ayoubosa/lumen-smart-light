#!/usr/bin/env node
/* ════════════════════════════════════
   NATHER MOCK CONTROLLER
   Speaks the same HTTP API as the ESP32 firmware and serves the website,
   so the whole system can be run and tested without hardware.

     node tools/mock-device.cjs            → http://localhost:8080
     PORT=9000 NATHER_TOKEN=secret node tools/mock-device.cjs

   Extra endpoints that only exist here (the real board has a real PIR):
     POST /api/sim/motion   {}              one motion pulse (3 s)
     POST /api/sim/light    {"light": 20}   set the ambient light %
   ════════════════════════════════════ */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createEngine } = require("../web/js/engine.js");

const WEB_ROOT = path.join(__dirname, "..", "web");
const MAX_BODY = 512;          // same limit as the firmware
const HEARTBEAT_MS = 10000;    // same as the firmware: push state even when nothing changed
const MOTION_PULSE_MS = 3000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json"
};

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "127.0.0.1";
}

function createMockDevice(options) {
  const opts = Object.assign({ token: "", autoOffSeconds: undefined, now: undefined }, options || {});
  const engine = createEngine({ autoOffSeconds: opts.autoOffSeconds, now: opts.now });
  const started = Date.now();
  const clients = new Set();
  const ip = lanAddress();

  function deviceInfo() {
    return {
      name: "nather",
      hostname: "nather.local",
      fw: "mock-1.0.0",
      mode: "sta",
      ip,
      mac: "02:00:00:4e:41:54",
      ssid: "mock-network",
      rssi: -52 - Math.round(Math.random() * 10),
      channel: 6,
      uptime: Math.round((Date.now() - started) / 1000),
      clients: clients.size,
      auth: !!opts.token,
      simulated: true
    };
  }

  function state() {
    const snap = engine.snapshot();
    snap.device = deviceInfo();
    return snap;
  }

  function broadcast() {
    const payload = "event: state\ndata: " + JSON.stringify(state()) + "\n\n";
    clients.forEach(res => res.write(payload));
  }

  engine.onChange(broadcast);
  const heartbeat = setInterval(broadcast, HEARTBEAT_MS);
  const ticker = setInterval(() => engine.tick(), 1000);
  heartbeat.unref();
  ticker.unref();

  function send(res, status, body) {
    const data = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(data);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", c => {
        size += c.length;
        if (size <= MAX_BODY) chunks.push(c);   // keep reading so the 413 can still be sent
      });
      req.on("end", () => {
        if (size > MAX_BODY) return reject(Object.assign(new Error("Body too large"), { status: 413 }));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null")); }
        catch { reject(Object.assign(new Error("Body is not valid JSON"), { status: 400 })); }
      });
      req.on("error", reject);
    });
  }

  function authorised(req) {
    if (!opts.token) return true;
    return req.headers["authorization"] === "Bearer " + opts.token;
  }

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(WEB_ROOT, rel));
    if (!file.startsWith(WEB_ROOT)) return send(res, 403, { error: "Forbidden" });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: "Not found" });
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
      res.end(data);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      });
      return res.end();
    }

    if (!p.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
      return serveStatic(req, res, p);
    }

    try {
      if (p === "/api/state" && req.method === "GET") return send(res, 200, state());

      if (p === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*"
        });
        res.write("retry: 2000\n");
        res.write("event: state\ndata: " + JSON.stringify(state()) + "\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      const writes = req.method === "PUT" || req.method === "POST";
      if (writes && !authorised(req)) return send(res, 401, { error: "Missing or wrong API token" });

      const roomMatch = p.match(/^\/api\/rooms\/([a-z]+)$/);
      if (roomMatch && req.method === "PUT") {
        return send(res, 200, engine.setRoom(roomMatch[1], await readJson(req)));
      }

      if (p === "/api/entry-rooms" && req.method === "PUT") {
        const body = await readJson(req);
        return send(res, 200, { rooms: engine.setEntryRooms(body && body.rooms) });
      }

      if (p === "/api/sim/motion" && req.method === "POST") {
        const turnedOn = engine.setMotion(true);
        setTimeout(() => engine.setMotion(false), MOTION_PULSE_MS).unref();
        return send(res, 200, { turnedOn });
      }

      if (p === "/api/sim/light" && req.method === "POST") {
        const body = await readJson(req);
        engine.setLight(body ? body.light : null);
        return send(res, 200, { light: engine.snapshot().sensors.light });
      }

      return send(res, 404, { error: "Not found" });
    } catch (err) {
      return send(res, err.status || 500, { error: err.message });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(ticker);
    clients.forEach(res => res.end());
  });
  return { server, engine };
}

module.exports = { createMockDevice };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const { server } = createMockDevice({ token: process.env.NATHER_TOKEN || "" });
  server.listen(port, () => {
    console.log("Nather mock controller on http://localhost:" + port + "/");
    console.log("API: GET /api/state · PUT /api/rooms/{id} · PUT /api/entry-rooms · GET /api/events");
    if (process.env.NATHER_TOKEN) console.log("Writes need: Authorization: Bearer <NATHER_TOKEN>");
  });
}
