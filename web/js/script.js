/* ════════════════════════════════════
   LIGHTS PAGE
   One card per room (switch + brightness), the motion-lighting settings,
   and a plain-language notice about what the page is connected to.
   All reads and writes go through js/device.js.
   ════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", async () => {
  const device = window.NatherDevice;
  const roomList = document.getElementById("roomList");
  if (!device || !roomList) return;

  const ROOMS = [
    ["living", "Living room"],
    ["bedroom", "Bedroom"],
    ["kitchen", "Kitchen"],
    ["bathroom", "Bathroom"],
    ["hallway", "Hallway"],
    ["garage", "Garage"]
  ];

  const HW_TEXT = {
    pwm: "Dimmable LED",
    relay: "Relay switch, on or off only",
    none: "No light wired yet. The setting is kept for later."
  };

  const notice = document.getElementById("connNotice");
  const allOffBtn = document.getElementById("allOffBtn");
  const entryList = document.getElementById("entryList");
  const motionStatus = document.getElementById("motionStatus");
  const lightStatus = document.getElementById("lightStatus");
  const simMotionBtn = document.getElementById("simMotionBtn");

  await device.ready;
  const st = () => device.state;

  /* ─── helpers ─── */

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === "className") node.className = v;
      else node.setAttribute(k, v);
    });
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const relTime = new Intl.RelativeTimeFormat(navigator.language || "en", { numeric: "auto" });
  function ago(seconds) {
    if (seconds < 60) return relTime.format(-seconds, "second");
    if (seconds < 3600) return relTime.format(-Math.floor(seconds / 60), "minute");
    return relTime.format(-Math.floor(seconds / 3600), "hour");
  }

  /* ─── connection notice ─── */

  let noticeKind = null;
  function renderNotice() {
    const kind = device.mode === "demo" ? "demo" : device.link === "online" ? "online" : "offline";
    if (kind === noticeKind) return;   // only re-announce when something actually changed
    noticeKind = kind;
    notice.hidden = false;
    notice.dataset.kind = kind;
    notice.replaceChildren();
    const p = el("p");
    if (kind === "demo") {
      p.append(el("strong", {}, "Demo mode. "), "No controller is connected, so these lights are simulated in your browser.");
      const btn = el("button", { type: "button", className: "btn" }, "Connect a Controller");
      btn.addEventListener("click", (e) => { e.stopPropagation(); device.openPanel(); });
      notice.append(p, btn);
    } else if (kind === "online") {
      const name = (st().device && st().device.hostname) || device.address;
      p.append(el("strong", {}, "Connected "), "to ", el("span", { translate: "no" }, name), ". Changes switch the real lights.");
      notice.append(p);
    } else {
      p.append(el("strong", {}, "Connection lost. "), "Trying again. Check that the controller is powered and on the same Wi-Fi.");
      notice.append(p);
    }
  }

  /* ─── rooms ─── */

  const cards = {};

  function buildRoom(id, name) {
    const hw = st().rooms[id].hw;
    const li = el("li", { className: "room", id: "room-" + id });

    const top = el("div", { className: "room-top" });
    const lamp = el("span", { className: "lamp", "aria-hidden": "true" });
    const nameBox = el("div", { className: "room-name" });
    nameBox.append(el("h3", { id: "name-" + id }, name), el("p", { className: "room-state", id: "state-" + id }, "Off"));
    const sw = el("button", { type: "button", className: "switch", role: "switch", "aria-checked": "false", "aria-labelledby": "name-" + id });
    sw.addEventListener("click", () => device.setRoom(id, { on: !st().rooms[id].on }));
    top.append(lamp, nameBox, sw);
    li.append(top);

    let slider = null, output = null;
    if (hw !== "relay") {
      const row = el("div", { className: "slider-row" });
      row.append(el("label", { for: "dim-" + id }, "Brightness"));
      slider = el("input", { type: "range", id: "dim-" + id, min: "0", max: "100", step: "1", value: "0" });
      output = el("output", { for: "dim-" + id, className: "slider-value" }, "0%");
      row.append(slider, output);
      li.append(row);

      // while the thumb is held, the controller's echoes must not move it
      slider.addEventListener("pointerdown", () => { slider.dataset.busy = "1"; });
      const release = () => { delete slider.dataset.busy; render(); };
      slider.addEventListener("pointerup", release);
      slider.addEventListener("pointercancel", release);
      slider.addEventListener("input", () => {
        output.textContent = slider.value + "%";
        device.setRoom(id, { brightness: Number(slider.value) });
      });
    }

    const pin = st().rooms[id].pin;
    li.append(el("p", { className: "room-hw" }, HW_TEXT[hw] + (pin >= 0 ? ", GPIO " + pin : "")));

    roomList.append(li);
    cards[id] = { li, lamp, sw, slider, output, state: nameBox.querySelector(".room-state") };
  }

  function renderRooms() {
    let anyOn = false;
    ROOMS.forEach(([id]) => {
      const r = st().rooms[id];
      const c = cards[id];
      if (!r || !c) return;
      anyOn = anyOn || r.on;
      c.li.classList.toggle("is-on", r.on);
      c.lamp.style.setProperty("--level", r.on ? (0.25 + 0.75 * r.brightness / 100).toFixed(2) : 0);
      c.sw.setAttribute("aria-checked", r.on);
      let text = "Off";
      if (r.on) text = r.hw === "relay" ? "On" : "On, " + r.brightness + "%";
      if (r.on && r.auto) text += " (by motion)";
      c.state.textContent = text;
      if (c.slider && !c.slider.dataset.busy) {
        c.slider.value = r.brightness;
        c.slider.setAttribute("aria-valuetext", r.brightness + "%");
        c.output.textContent = r.brightness + "%";
      }
    });
    allOffBtn.disabled = !anyOn;
  }

  allOffBtn.addEventListener("click", () => {
    ROOMS.forEach(([id]) => { if (st().rooms[id].on) device.setRoom(id, { on: false }); });
  });

  /* ─── motion lighting ─── */

  const checks = {};
  ROOMS.forEach(([id, name]) => {
    const label = el("label", { className: "check" });
    const box = el("input", { type: "checkbox", name: "entry", value: id });
    box.addEventListener("change", () => {
      device.setEntryRooms(ROOMS.map(([rid]) => rid).filter(rid => checks[rid].checked));
    });
    label.append(box, el("span", {}, name));
    entryList.append(label);
    checks[id] = box;
  });

  function renderMotion() {
    const s = st();
    ROOMS.forEach(([id]) => { checks[id].checked = s.entryRooms.includes(id); });
    const sens = s.sensors;
    motionStatus.dataset.active = sens.motion;
    if (sens.motion) motionStatus.textContent = "Movement detected";
    else if (sens.lastMotionAgo !== null) motionStatus.textContent = "No movement. Last seen " + ago(sens.lastMotionAgo) + ".";
    else motionStatus.textContent = "No movement yet";
    if (sens.light === null) lightStatus.textContent = "Not fitted, so motion lighting works at any time";
    else lightStatus.textContent = sens.light + "%, " + (sens.dark ? "dark enough for motion lighting" : "too bright, motion lighting paused");
    simMotionBtn.hidden = !(s.device && s.device.simulated);
  }

  simMotionBtn.addEventListener("click", () => device.simulateMotion());

  /* ─── wire up ─── */

  function render() {
    renderNotice();
    renderRooms();
    renderMotion();
  }

  ROOMS.forEach(([id, name]) => buildRoom(id, name));
  device.onChange(render);
  render();

  // links like index.html#room-kitchen (old room pages redirect here)
  if (location.hash) {
    const target = document.getElementById(location.hash.slice(1));
    if (target) target.scrollIntoView({ block: "start" });
  }
});
