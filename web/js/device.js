/* ════════════════════════════════════
   NATHER DEVICE LINK
   Finds the ESP32 controller and keeps the page in sync with it.

   device mode — the page talks to a controller over HTTP:
                   GET  api/state         full state
                   PUT  api/rooms/{id}    {brightness} or {on}
                   PUT  api/entry-rooms   {rooms: [...]}
                   PUT  api/mode          {mode: "auto" | "manual"}
                   GET  api/events        Server-Sent Events push
   demo mode   — no controller answered, so a simulated one runs in the
                 browser (js/engine.js) and state lives in localStorage.

   See docs/API.md for the full contract.
   ════════════════════════════════════ */
(function () {
  const DEVICE_KEY = "nather_device_url";
  const TOKEN_KEY = "nather_api_token";
  const DEMO_KEY = "nather_demo_state";
  const PROBE_TIMEOUT_MS = 2500;
  const DEMO_TICK_MS = 5000;

  const listeners = new Set();
  let mode = "connecting";   // "device" | "demo"
  let link = "connecting";   // "online" | "offline" | "demo"
  let base = "";
  let state = null;
  let engine = null;
  let lastRtt = null;
  let lastError = null;
  const sendQueue = {};      // room id -> { inflight, dirty }

  function emit() {
    listeners.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } });
  }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function storageSet(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch { /* private mode: ignore */ }
  }

  function normaliseBase(url) {
    url = (url || "").trim();
    if (!url) return "";
    if (!/^https?:\/\//i.test(url)) url = "http://" + url;
    return url.replace(/\/+$/, "") + "/";
  }

  /* ─── HTTP ─── */

  async function request(method, path, body, timeoutMs) {
    const headers = {};
    const token = storageGet(TOKEN_KEY);
    if (token) headers["Authorization"] = "Bearer " + token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const started = performance.now();
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs || 5000)
    });
    lastRtt = Math.round(performance.now() - started);
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || ("HTTP " + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function probe(url) {
    const prev = base;
    base = url;
    try {
      const data = await request("GET", "api/state", undefined, PROBE_TIMEOUT_MS);
      if (data && data.device && data.rooms) return data;
    } catch { /* not a controller */ }
    base = prev;
    return null;
  }

  async function withAuth(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.status !== 401) throw err;
      const token = window.prompt("This controller needs its API token (set in firmware/include/secrets.h):");
      if (!token) throw err;
      storageSet(TOKEN_KEY, token.trim());
      return fn();
    }
  }

  /* ─── DEVICE MODE ─── */

  function startDevice(url, data) {
    mode = "device";
    link = "online";
    base = url;
    state = data;
    const es = new EventSource(base + "api/events");
    es.addEventListener("state", (e) => {
      try {
        const next = JSON.parse(e.data);
        // keep optimistic values for rooms that still have writes in flight
        Object.keys(sendQueue).forEach(id => {
          const q = sendQueue[id];
          if ((q.inflight || q.dirty) && state.rooms[id]) next.rooms[id] = state.rooms[id];
        });
        state = next;
        link = "online";
        lastError = null;
        emit();
      } catch (err) { console.error("Bad state event", err); }
    });
    es.onopen = () => { link = "online"; emit(); };
    es.onerror = () => { link = "offline"; emit(); }; // EventSource retries by itself
  }

  /* Send the room's absolute brightness. Absolute values make writes
     idempotent, so while one request is in flight we only remember that
     another is needed and send the latest value when it returns. */
  function queueRoomSend(id) {
    const q = sendQueue[id] || (sendQueue[id] = { inflight: false, dirty: false });
    if (q.inflight) { q.dirty = true; return; }
    q.inflight = true;
    q.dirty = false;
    const brightness = state.rooms[id].brightness;
    withAuth(() => request("PUT", "api/rooms/" + encodeURIComponent(id), { brightness }))
      .then(room => {
        if (!q.dirty && room) Object.assign(state.rooms[id], room);
        link = "online";
        lastError = null;
      })
      .catch(err => {
        lastError = err.message;
        link = err.status ? "online" : "offline";
        return refresh();
      })
      .finally(() => {
        q.inflight = false;
        if (q.dirty) queueRoomSend(id);
        else emit();
      });
  }

  async function refresh() {
    try {
      state = await request("GET", "api/state");
      link = "online";
    } catch { link = "offline"; }
    emit();
  }

  /* ─── DEMO MODE ─── */

  function readDemoState() {
    try {
      const saved = JSON.parse(storageGet(DEMO_KEY));
      if (saved) return saved;
      // carry over state saved by the first version of the site
      const oldRooms = JSON.parse(storageGet("nather_rooms"));
      const oldEntry = JSON.parse(storageGet("nather_entry_rooms"));
      if (oldRooms || oldEntry) return { rooms: oldRooms || {}, entryRooms: oldEntry || [] };
    } catch { /* corrupt storage: start fresh */ }
    return null;
  }

  function demoSnapshot() {
    const snap = engine.snapshot();
    snap.device = {
      name: "nather-demo",
      hostname: "in-browser simulation",
      fw: "demo",
      mode: "demo",
      ip: null,
      mac: null,
      ssid: null,
      rssi: null,
      uptime: Math.round(performance.now() / 1000),
      auth: false,
      simulated: true
    };
    return snap;
  }

  function startDemo() {
    mode = "demo";
    link = "demo";
    engine = window.NatherEngine.createEngine();
    engine.load(readDemoState());
    engine.onChange(() => {
      state = demoSnapshot();
      storageSet(DEMO_KEY, JSON.stringify({ mode: state.mode, rooms: state.rooms, entryRooms: state.entryRooms }));
      emit();
    });
    state = demoSnapshot();
    setInterval(() => { engine.tick(); }, DEMO_TICK_MS);
  }

  /* ─── STARTUP ─── */

  async function init() {
    const params = new URLSearchParams(location.search);
    if (params.has("demo")) return startDemo();

    // 1. Served by the controller itself (or the mock): same origin.
    if (location.protocol.startsWith("http")) {
      const data = await probe("");
      if (data) return startDevice("", data);
    }

    // 2. A controller address saved from the connection panel.
    const saved = storageGet(DEVICE_KEY);
    const blocked = saved && location.protocol === "https:" && saved.startsWith("http:");
    if (saved && !blocked) {
      const url = normaliseBase(saved);
      const data = await probe(url);
      if (data) return startDevice(url, data);
    }

    startDemo();
  }

  const ready = init().then(() => { renderBadge(); emit(); });

  /* ─── PUBLIC API ─── */

  function setRoom(id, patch) {
    if (mode === "demo") {
      try { engine.setRoom(id, patch); } catch (e) { console.warn(e.message); }
      return;
    }
    const room = state.rooms[id];
    if (!room) return;
    window.NatherEngine.applyPatch(room, patch, 50);
    emit();
    queueRoomSend(id);
  }

  function setEntryRooms(list) {
    if (mode === "demo") { engine.setEntryRooms(list); return; }
    state.entryRooms = list.slice();
    emit();
    withAuth(() => request("PUT", "api/entry-rooms", { rooms: list }))
      .then(res => { state.entryRooms = res.rooms; lastError = null; emit(); })
      .catch(err => { lastError = err.message; refresh(); });
  }

  function setMode(next) {
    if (mode === "demo") { engine.setMode(next); return; }
    state.mode = next;
    if (next === "manual") Object.values(state.rooms).forEach(r => { r.auto = false; });
    emit();
    withAuth(() => request("PUT", "api/mode", { mode: next }))
      .then(res => { state.mode = res.mode; lastError = null; emit(); })
      .catch(err => { lastError = err.message; refresh(); });
  }

  function simulateMotion() {
    if (mode === "demo") {
      engine.setMotion(true);
      setTimeout(() => engine.setMotion(false), 3000);
      return;
    }
    if (state.device && state.device.simulated) {
      withAuth(() => request("POST", "api/sim/motion", {})).catch(err => { lastError = err.message; emit(); });
    }
  }

  function connectTo(url) {
    storageSet(DEVICE_KEY, url ? normaliseBase(url) : null);
    const target = new URL(location.href);
    target.searchParams.delete("demo");
    location.href = target.toString();
  }

  function useDemo() {
    storageSet(DEVICE_KEY, null);
    const target = new URL(location.href);
    target.searchParams.set("demo", "1");
    location.href = target.toString();
  }

  /* ════════════════════════════════════
     CONNECTION BADGE + PANEL (site header)
     ════════════════════════════════════ */

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function signalLabel(rssi) {
    if (rssi === null || rssi === undefined) return "n/a";
    let q = "weak";
    if (rssi >= -55) q = "excellent";
    else if (rssi >= -67) q = "good";
    else if (rssi >= -75) q = "fair";
    return rssi + " dBm (" + q + ")";
  }

  function formatUptime(s) {
    if (s === null || s === undefined) return "n/a";
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return d + "d " + h + "h";
    if (h) return h + "h " + m + "m";
    return m + "m " + (s % 60) + "s";
  }

  let badge = null;
  let panel = null;

  function renderBadge() {
    const nav = document.querySelector(".site-header .header-row");
    if (!nav) return;
    if (!badge) {
      badge = el("button", "conn-badge");
      badge.setAttribute("aria-live", "polite");
      badge.type = "button";
      badge.setAttribute("aria-haspopup", "dialog");
      badge.setAttribute("aria-expanded", "false");
      badge.addEventListener("click", (e) => { e.stopPropagation(); togglePanel(); });
      nav.appendChild(badge);
      document.addEventListener("click", (e) => {
        if (panel && !panel.contains(e.target)) closePanel();
      });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });
      listeners.add(() => { updateBadge(); if (panel) fillPanel(); });
    }
    updateBadge();
  }

  function updateBadge() {
    if (!badge) return;
    const labels = { online: "Connected", offline: "Reconnecting…", demo: "Demo Mode", connecting: "Connecting…" };
    badge.dataset.link = link;
    const dot = el("span", "conn-dot");
    dot.setAttribute("aria-hidden", "true");
    badge.replaceChildren(dot, el("span", "conn-text", labels[link] || link));
    badge.title = mode === "device" ? "Controller at " + (base || location.host) : "No controller found, simulated in this browser";
    badge.setAttribute("aria-label", (labels[link] || link) + ". Show connection details");
  }

  function row(list, label, value) {
    const r = el("div", "conn-row");
    r.append(el("span", "conn-k", label), el("span", "conn-v", value === null || value === undefined ? "n/a" : String(value)));
    list.appendChild(r);
  }

  function fillPanel() {
    const d = (state && state.device) || {};
    panel.replaceChildren();
    const title = el("h3", "conn-title", mode === "device" ? "Controller" : "Demo Mode");
    panel.appendChild(title);

    if (mode === "device") {
      const list = el("div", "conn-list");
      row(list, "Link", link === "online" ? "Live (Server-Sent Events)" : "Lost, retrying");
      row(list, "Address", base || location.origin);
      row(list, "Hostname", d.hostname);
      row(list, "IP", d.ip);
      row(list, "MAC", d.mac);
      row(list, "Wi-Fi", d.mode === "ap" ? "Setup hotspot (" + d.ssid + ")" : d.ssid);
      row(list, "Signal", signalLabel(d.rssi));
      row(list, "Round trip", lastRtt === null ? null : lastRtt + " ms");
      row(list, "Uptime", formatUptime(d.uptime));
      row(list, "Firmware", d.fw + (d.simulated ? " (mock)" : ""));
      row(list, "Write auth", d.auth ? "Token required" : "Open");
      panel.appendChild(list);
      if (lastError) panel.appendChild(el("p", "conn-error", "Last request failed: " + lastError + ". Check the board is powered and on the same network, then try again."));
      const actions = el("div", "conn-actions");
      const demoBtn = el("button", "conn-btn ghost", "Switch to Demo Mode");
      demoBtn.type = "button";
      demoBtn.addEventListener("click", useDemo);
      actions.appendChild(demoBtn);
      panel.appendChild(actions);
      return;
    }

    panel.appendChild(el("p", "conn-note",
      "No controller answered, so the lights are simulated in this browser. Connect to the ESP32 to control real hardware."));

    if (location.protocol === "https:") {
      panel.appendChild(el("p", "conn-note",
        "Browsers block an HTTPS page from calling a plain-HTTP device. Open the controller's own page on your network instead:"));
      const a = el("a", "conn-btn", "Open nather.local");
      a.setAttribute("translate", "no");
      a.href = "http://nather.local/";
      panel.appendChild(a);
      return;
    }

    const form = el("form", "conn-form");
    const label = el("label", "conn-k", "Controller address");
    const input = el("input", "conn-input");
    input.type = "text";
    input.placeholder = "nather.local or 192.168.1.50…";
    input.name = "controller";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("inputmode", "url");
    input.setAttribute("autocapitalize", "off");
    input.value = (storageGet(DEVICE_KEY) || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    input.id = "connAddress";
    label.htmlFor = "connAddress";
    const btn = el("button", "conn-btn", "Connect to Controller");
    btn.type = "submit";
    form.append(label, input, btn);
    form.addEventListener("submit", (e) => { e.preventDefault(); if (input.value.trim()) connectTo(input.value); });
    panel.appendChild(form);
  }

  function togglePanel() {
    if (panel) { closePanel(); return; }
    panel = el("div", "conn-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Controller connection");
    panel.addEventListener("click", (e) => e.stopPropagation());
    fillPanel();
    document.querySelector(".site-header").appendChild(panel);
    badge.setAttribute("aria-expanded", "true");
  }

  function closePanel() {
    if (!panel) return;
    panel.remove();
    panel = null;
    if (badge) badge.setAttribute("aria-expanded", "false");
  }

  window.NatherDevice = {
    ready,
    get mode() { return mode; },
    get link() { return link; },
    get state() { return state; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setRoom,
    setEntryRooms,
    setMode,
    simulateMotion,
    connectTo,
    useDemo,
    openPanel() { if (!panel) togglePanel(); },
    get address() { return base || location.host; }
  };
})();
