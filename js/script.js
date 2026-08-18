document.addEventListener("DOMContentLoaded", () => {

  /* ─── MOBILE MENU ─── */
  const menuBtn = document.getElementById("menuBtn");
  const navLinks = document.getElementById("navLinks");
  if (menuBtn && navLinks) {
    menuBtn.addEventListener("click", () => {
      navLinks.classList.toggle("open");
      /* also handle dropdown in mobile */
      const dd = navLinks.querySelector(".nav-dropdown");
      if (dd && navLinks.classList.contains("open")) {
        dd.addEventListener("click", (e) => {
          if (window.innerWidth <= 768) {
            e.preventDefault();
            dd.classList.toggle("open");
          }
        });
      }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".navbar")) navLinks.classList.remove("open");
    });
  }

  /* ─── CONSTANTS ─── */
  const STORAGE_KEY = "nather_rooms";
  const ENTRY_KEY = "nather_entry_rooms";

  const ROOM_ICONS = {
    living: "&#127968;",
    bedroom: "&#128716;",
    kitchen: "&#127858;",
    bathroom: "&#128702;",
    hallway: "&#128682;",
    garage: "&#128663;"
  };

  const ROOM_NAMES = {
    living: "Living Room",
    bedroom: "Bedroom",
    kitchen: "Kitchen",
    bathroom: "Bathroom",
    hallway: "Hallway",
    garage: "Garage"
  };

  const COMPONENTS = {
    pir: {
      name: "PIR Motion Sensor",
      icon: "&#9898;",
      badge: "Sensor",
      image: "img/pir-sensor.jpg",
      description: "The Passive Infrared (PIR) motion sensor detects movement by measuring changes in infrared radiation emitted by warm objects like people or animals. When a warm body moves across the sensor&#8217;s field of view, the difference in infrared levels triggers a HIGH signal. This sensor is ideal for automatic lighting, security systems, and energy-saving applications. Its adjustable sensitivity and delay settings make it versatile for any room.",
      specs: [
        { label: "Model", value: "HC-SR501" },
        { label: "Voltage", value: "5V &#8211; 12V DC" },
        { label: "Range", value: "Up to 7 meters" },
        { label: "Angle", value: "120&#176; cone" }
      ]
    },
    led: {
      name: "LED Light",
      icon: "&#9728;",
      badge: "Lighting",
      image: "img/led-light.jpg",
      description: "High-efficiency Light Emitting Diode (LED) designed for smart home illumination. LEDs consume up to 80% less energy than traditional bulbs while providing instant, flicker-free light. Paired with a PWM driver, this LED supports smooth dimming from 0% to 100%, enabling warm sunrises, cozy evenings, or bright task lighting &#8212; all controllable from your device.",
      specs: [
        { label: "Type", value: "SMD 5050" },
        { label: "Power", value: "9W (equivalent 60W)" },
        { label: "Lumens", value: "800 lm" },
        { label: "Color Temp", value: "2700K &#8211; 6500K" }
      ]
    },
    esp32: {
      name: "ESP32 Microcontroller",
      icon: "&#9000;",
      badge: "Controller",
      image: "img/esp32-board.jpg",
      description: "The ESP32 is a powerful, low-cost microcontroller with built-in Wi-Fi and Bluetooth. It serves as the brain of the Nather system, handling sensor input, relay control, and wireless communication. Dual-core processing, ample GPIO pins, and deep-sleep modes make it perfect for always-on IoT applications. It connects directly to your home network so you can control lights from anywhere.",
      specs: [
        { label: "Chip", value: "ESP32-WROOM-32" },
        { label: "CPU", value: "Dual-core 240 MHz" },
        { label: "Connectivity", value: "Wi-Fi + Bluetooth" },
        { label: "GPIO Pins", value: "25 available" }
      ]
    },
    relay: {
      name: "Relay Module",
      icon: "&#8644;",
      badge: "Switching",
      image: "img/relay-module.jpg",
      description: "An electromechanical relay module that safely switches high-voltage AC or DC loads using a low-voltage signal from the ESP32. It provides complete isolation between the control circuit and the power circuit, protecting your microcontroller. The built-in optocoupler and flyback diode ensure reliable operation. This module is rated for household lighting circuits and supports both normally-open and normally-closed configurations.",
      specs: [
        { label: "Channels", value: "2-channel" },
        { label: "Max Load", value: "10A / 250V AC" },
        { label: "Trigger", value: "Active LOW" },
        { label: "Isolation", value: "Optocoupler" }
      ]
    }
  };

  /* ════════════════════════════════════
     CIRCULAR KNOB COMPONENT (v2 — fixed sensitivity)
     ════════════════════════════════════ */

  function createKnob(el, opts) {
    const fill = el.querySelector(".knob-fill");
    const handle = el.querySelector(".knob-handle");
    const innerDot = el.querySelector(".knob-handle-inner");
    const valueEl = el.querySelector(".knob-value");
    const svg = el.querySelector("svg");
    let value = opts.initialValue || 0;
    let dragging = false;
    const onChange = opts.onChange || function(){};

    const ARC_LENGTH = 329.87;
    const GAP_LENGTH = 109.96;
    const cx = 100, cy = 100, r = 70;

    function valueToOffset(v) {
      return ARC_LENGTH * (1 - v / 100);
    }

    function valueToHandlePos(v) {
      const angleDeg = -135 + (270 * v / 100);
      const angleRad = angleDeg * Math.PI / 180;
      return {
        x: cx + r * Math.cos(angleRad),
        y: cy + r * Math.sin(angleRad)
      };
    }

    function setValue(v, isDragging) {
      v = Math.round(Math.max(0, Math.min(100, v)));
      if (v === value && !isDragging) return;
      value = v;
      const offset = valueToOffset(v);
      const pos = valueToHandlePos(v);
      if (fill) {
        fill.setAttribute("stroke-dashoffset", offset);
        fill.classList.toggle("dragging", isDragging);
      }
      if (handle) {
        handle.setAttribute("cx", pos.x);
        handle.setAttribute("cy", pos.y);
        handle.setAttribute("r", isDragging ? 10 : 8);
        handle.classList.toggle("dragging", isDragging);
      }
      if (innerDot) {
        innerDot.setAttribute("cx", pos.x);
        innerDot.setAttribute("cy", pos.y);
        innerDot.classList.toggle("active", isDragging);
      }
      if (valueEl) valueEl.textContent = v;
      onChange(v, isDragging);
    }

    function angleToValue(clientX, clientY) {
      const rect = svg.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dx = clientX - centerX;
      const dy = clientY - centerY;
      let deg = Math.atan2(dy, dx) * 180 / Math.PI;
      deg = ((deg % 360) + 360) % 360;
      let v;
      if (deg >= 225) {
        v = ((deg - 225) / 270) * 100;
      } else if (deg <= 135) {
        v = ((deg + 135) / 270) * 100;
      } else {
        v = deg < 180 ? 100 : 0;
      }
      return Math.round(Math.max(0, Math.min(100, v)));
    }

    function onDown(e) {
      dragging = true;
      const pt = e.touches ? e.touches[0] : e;
      setValue(angleToValue(pt.clientX, pt.clientY), true);
    }

    function onMove(e) {
      if (!dragging) return;
      e.preventDefault();
      const pt = e.touches ? e.touches[0] : e;
      setValue(angleToValue(pt.clientX, pt.clientY), true);
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      setValue(value, false);
    }

    el.addEventListener("mousedown", onDown);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    el.addEventListener("touchstart", onDown, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onUp);

    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -3 : 3;
      setValue(value + delta, false);
    }, { passive: false });

    setValue(value, false);

    return { setValue: (v) => setValue(v, false), getValue: () => value };
  }

  /* ─── BULB RENDER HELPER ─── */

  function renderBulb(glassEl, glowEl, isOn, brightness) {
    if (!glassEl) return;
    if (isOn && brightness > 0) {
      const intensity = 0.3 + (brightness / 100) * 0.7;
      glassEl.setAttribute("fill", `rgba(255, 249, 230, ${intensity})`);
      glassEl.setAttribute("filter", `drop-shadow(0 0 ${20 + brightness * 0.3}px rgba(245, 197, 66, ${0.2 + brightness * 0.004}))`);
      glassEl.classList.add("on");
    } else {
      glassEl.setAttribute("fill", "#1a1a2e");
      glassEl.setAttribute("filter", "none");
      glassEl.classList.remove("on");
    }
    if (glowEl) {
      glowEl.classList.toggle("on", isOn && brightness > 0);
      if (isOn && brightness > 0) {
        glowEl.style.opacity = 0.2 + (brightness / 100) * 0.6;
      }
    }
  }

  /* ─── BULB TOGGLE PULSE ─── */

  function pulseBulb(wrapperEl) {
    if (!wrapperEl) return;
    wrapperEl.classList.remove("pulse");
    void wrapperEl.offsetWidth;
    wrapperEl.classList.add("pulse");
  }

  /* ════════════════════════════════════
     HOME PAGE — BULB TOGGLE + KNOB
     ════════════════════════════════════ */
  const toggle = document.getElementById("lightToggle");
  if (toggle) {
    const bulbGlass = document.getElementById("bulbGlass");
    const glow = document.getElementById("bulbGlow");
    const statusDot = document.getElementById("statusDot");
    const statusText = document.getElementById("statusText");
    const toggleLabel = document.getElementById("toggleLabel");
    const filaments = document.querySelectorAll(".bulb-filament");
    const bulbWrapper = document.querySelector(".bulb-wrapper");

    let isOn = toggle.dataset.state === "on";
    let bulbBrightness = parseInt(localStorage.getItem("nather_brightness")) || 0;

    function setLight(state, brightness) {
      isOn = state;
      if (brightness !== undefined) bulbBrightness = brightness;
      toggle.classList.toggle("on", isOn);
      renderBulb(bulbGlass, glow, isOn, bulbBrightness);
      if (statusDot) statusDot.classList.toggle("on", isOn);
      document.body.classList.toggle("lit", isOn);
      filaments.forEach(f => { f.style.opacity = isOn ? "1" : "0.3"; });
      if (statusText) statusText.textContent = isOn ? "On" : "Off";
      if (toggleLabel) toggleLabel.textContent = isOn ? "ON" : "OFF";
      toggle.dataset.state = isOn ? "on" : "off";
      if (isOn) pulseBulb(bulbWrapper);
    }

    const homeKnobEl = document.getElementById("homeKnob");
    let homeKnob = null;

    toggle.addEventListener("click", () => {
      const newState = !isOn;
      if (!newState) {
        setLight(false, 0);
        if (homeKnob) homeKnob.setValue(0);
      } else {
        const b = bulbBrightness || 50;
        setLight(true, b);
        if (homeKnob) homeKnob.setValue(b);
      }
      localStorage.setItem("nather_bulb", newState ? "on" : "off");
    });

    if (homeKnobEl) {
      const savedBrightness = parseInt(localStorage.getItem("nather_brightness")) || 0;
      homeKnob = createKnob(homeKnobEl, {
        initialValue: savedBrightness,
        onChange: (v, dragging) => {
          bulbBrightness = v;
          localStorage.setItem("nather_brightness", v);
          if (v > 0) {
            setLight(true, v);
            toggle.dataset.state = "on";
            localStorage.setItem("nather_bulb", "on");
          } else {
            setLight(false, 0);
            localStorage.setItem("nather_bulb", "off");
          }
          if (!dragging) pulseBulb(bulbWrapper);
        }
      });
      if (savedBrightness > 0) {
        setLight(true, savedBrightness);
        pulseBulb(bulbWrapper);
      }
    }

    const saved = localStorage.getItem("nather_bulb");
    if (saved === "on" && (!homeKnobEl || !homeKnob)) setLight(true);
  }

  /* ════════════════════════════════════
     GALLERY CAROUSEL
     ════════════════════════════════════ */
  const track = document.getElementById("galleryTrack");
  const prevBtn = document.getElementById("galleryPrev");
  const nextBtn = document.getElementById("galleryNext");
  const dotsContainer = document.getElementById("galleryDots");

  if (track && dotsContainer) {
    const slides = track.querySelectorAll(".gallery-slide");
    let current = 0;

    function renderDots() {
      dotsContainer.innerHTML = "";
      slides.forEach((_, i) => {
        const dot = document.createElement("button");
        dot.className = "gallery-dot" + (i === current ? " active" : "");
        dot.setAttribute("aria-label", "Go to slide " + (i + 1));
        dot.addEventListener("click", () => goTo(i));
        dotsContainer.appendChild(dot);
      });
    }

    function goTo(index) {
      const changed = index !== current;
      current = index;
      track.style.transform = "translateX(-" + (current * 100) + "%)";
      renderDots();
      if (changed) {
        track.style.opacity = "0.75";
        clearTimeout(track._ft);
        track._ft = setTimeout(() => { track.style.opacity = ""; }, 600);
      }
    }

    function next() { goTo((current + 1) % slides.length); }
    function prev() { goTo((current - 1 + slides.length) % slides.length); }

    if (prevBtn) prevBtn.addEventListener("click", prev);
    if (nextBtn) nextBtn.addEventListener("click", next);

    let autoplay = setInterval(next, 5000);
    track.addEventListener("mouseenter", () => clearInterval(autoplay));
    track.addEventListener("mouseleave", () => { autoplay = setInterval(next, 5000); });

    /* ─── GALLERY SWIPE ─── */
    const galleryWrap = track.parentElement;
    let gStartX = 0, gDeltaX = 0, gSwiping = false;

    function gSwipeStart(e) {
      gStartX = e.touches ? e.touches[0].clientX : e.clientX;
      gDeltaX = 0;
      gSwiping = true;
      track.style.transition = "none";
    }

    function gSwipeMove(e) {
      if (!gSwiping) return;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      gDeltaX = x - gStartX;
      track.style.transform = "translateX(calc(-" + (current * 100) + "% + " + gDeltaX + "px))";
    }

    function gSwipeEnd() {
      if (!gSwiping) return;
      gSwiping = false;
      track.style.transition = "";
      if (Math.abs(gDeltaX) > 50) {
        gDeltaX > 0 ? prev() : next();
      } else {
        goTo(current);
      }
    }

    galleryWrap.addEventListener("touchstart", gSwipeStart, { passive: true });
    galleryWrap.addEventListener("touchmove", gSwipeMove, { passive: true });
    galleryWrap.addEventListener("touchend", gSwipeEnd);
    galleryWrap.addEventListener("mousedown", gSwipeStart);
    galleryWrap.addEventListener("mousemove", gSwipeMove);
    galleryWrap.addEventListener("mouseup", gSwipeEnd);
    galleryWrap.addEventListener("mouseleave", gSwipeEnd);

    renderDots();
  }

  /* ════════════════════════════════════
     CONTROL PAGE — ROOM MANAGEMENT
     ════════════════════════════════════ */
  const roomGrid = document.getElementById("roomGrid");
  const roomDetail = document.getElementById("roomDetail");
  const closeDetail = document.getElementById("closeDetail");
  const detailToggleEl = document.getElementById("detailToggle");

  let activeRoom = null;

  function loadRooms() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || defaultRooms();
    } catch { return defaultRooms(); }
  }

  function defaultRooms() {
    return {
      living: { on: false, brightness: 0 },
      bedroom: { on: false, brightness: 0 },
      kitchen: { on: false, brightness: 0 },
      bathroom: { on: false, brightness: 0 },
      hallway: { on: false, brightness: 0 },
      garage: { on: false, brightness: 0 }
    };
  }

  function saveRooms(rooms) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms));
  }

  function updateRoomUI(rooms) {
    for (const [id, state] of Object.entries(rooms)) {
      const dot = document.getElementById("dot-" + id);
      const status = document.getElementById("status-" + id);
      const glow = document.getElementById("glow-" + id);
      const brightness = document.getElementById("brightness-" + id);
      const card = document.querySelector(`.room-card[data-room="${id}"]`);
      if (dot) dot.classList.toggle("on", state.on);
      if (status) status.textContent = state.on ? "On" : "Off";
      if (glow) glow.classList.toggle("on", state.on);
      if (brightness) brightness.textContent = "Brightness: " + (state.on ? state.brightness : 0) + "%";
      if (card) card.style.borderColor = state.on ? "rgba(245,197,66,0.3)" : "";
    }
  }

  let rooms = loadRooms();

  if (roomGrid) {
    updateRoomUI(rooms);
    roomGrid.addEventListener("click", (e) => {
      const card = e.target.closest(".room-card");
      if (!card) return;
      if (e.target.closest("a")) return;
      const room = card.dataset.room;
      openRoomDetail(room);
    });
  }

  const detailKnobEl = document.getElementById("detailKnob");
  let detailKnob = null;
  if (detailKnobEl) {
    detailKnob = createKnob(detailKnobEl, {
      initialValue: 0,
      onChange: (v) => {
        if (!activeRoom) return;
        const state = rooms[activeRoom];
        state.brightness = v;
        state.on = v > 0;
        if (detailToggleEl) detailToggleEl.classList.toggle("on", state.on);
        saveRooms(rooms);
        updateRoomUI(rooms);
        if (state.on && typeof autoUpdatePIR === "function") autoUpdatePIR();
      }
    });
  }

  function openRoomDetail(room) {
    activeRoom = room;
    const state = rooms[room];
    if (!state) return;
    document.querySelectorAll(".room-card").forEach(c => c.classList.remove("active-room"));
    const activeCard = document.querySelector(`.room-card[data-room="${room}"]`);
    if (activeCard) activeCard.classList.add("active-room");
    const detailIcon = document.getElementById("detailIcon");
    const detailName = document.getElementById("detailName");
    if (detailIcon) detailIcon.innerHTML = ROOM_ICONS[room] || "&#127968;";
    if (detailName) detailName.textContent = ROOM_NAMES[room] || room;
    if (detailToggleEl) detailToggleEl.classList.toggle("on", state.on);
    if (detailKnob) detailKnob.setValue(state.on ? state.brightness : 0);
    if (roomDetail) {
      roomDetail.classList.add("visible");
      roomDetail.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  if (closeDetail) {
    closeDetail.addEventListener("click", () => {
      roomDetail.classList.remove("visible");
      document.querySelectorAll(".room-card").forEach(c => c.classList.remove("active-room"));
      activeRoom = null;
    });
  }

  if (detailToggleEl) {
    detailToggleEl.addEventListener("click", () => {
      if (!activeRoom) return;
      const state = rooms[activeRoom];
      state.on = !state.on;
      state.brightness = state.on ? Math.max(state.brightness, 10) : 0;
      if (detailKnob) detailKnob.setValue(state.brightness);
      detailToggleEl.classList.toggle("on", state.on);
      saveRooms(rooms);
      updateRoomUI(rooms);
    });
  }

  /* ════════════════════════════════════
     ENTRY LIGHTING
     ════════════════════════════════════ */
  const autoGrid = document.getElementById("autoLightGrid");
  const autoStatusDot = document.getElementById("autoStatusDot");
  const autoStatusText = document.getElementById("autoStatusText");

  /* FUTURE: Replace localStorage calls below with an API call.
     Example:
       fetch("/api/entry-rooms", { method: "PUT", body: JSON.stringify(selected) })
     Swap localStorage.getItem / setItem in these two functions — everything
     else stays the same. */
  function loadEntryRooms() {
    try {
      return JSON.parse(localStorage.getItem(ENTRY_KEY)) || [];
    } catch { return []; }
  }

  /* FUTURE API CALL SITE: Replace localStorage.setItem with fetch PUT above. */
  function saveEntryRooms(selected) {
    localStorage.setItem(ENTRY_KEY, JSON.stringify(selected));
  }

  let entryRooms = loadEntryRooms();

  function renderEntryRooms() {
    if (!autoGrid) return;
    autoGrid.querySelectorAll(".auto-room-card").forEach(card => {
      card.classList.toggle("selected", entryRooms.includes(card.dataset.autoRoom));
    });
  }

  function autoUpdatePIR() {
    const anyOn = Object.values(rooms).some(r => r.on);
    if (!autoStatusDot || !autoStatusText) return;
    if (anyOn) {
      autoStatusDot.classList.add("active");
      autoStatusText.textContent = "Motion detected — lights active";
    } else {
      const turnedOn = entryRooms.some(room => {
        if (rooms[room] && !rooms[room].on) {
          rooms[room].on = true;
          rooms[room].brightness = 70;
          return true;
        }
        return false;
      });
      if (turnedOn) {
        saveRooms(rooms);
        updateRoomUI(rooms);
        autoStatusDot.classList.add("active");
        autoStatusText.textContent = "Motion detected — auto lights activated";
      } else {
        autoStatusDot.classList.remove("active");
        autoStatusText.textContent = "Waiting for motion...";
      }
    }
  }

  if (autoGrid) {
    renderEntryRooms();
    autoGrid.addEventListener("click", (e) => {
      const card = e.target.closest(".auto-room-card");
      if (!card) return;
      const room = card.dataset.autoRoom;
      const idx = entryRooms.indexOf(room);
      if (idx >= 0) entryRooms.splice(idx, 1);
      else entryRooms.push(room);
      saveEntryRooms(entryRooms);
      renderEntryRooms();
    });
    if (entryRooms.length > 0) {
      autoUpdatePIR();
      setInterval(autoUpdatePIR, 8000);
    }
  }

  /* ════════════════════════════════════
     ACCORDION TOGGLE
     ════════════════════════════════════ */
  const accordionToggles = document.querySelectorAll(".accordion-header");
  accordionToggles.forEach(header => {
    header.addEventListener("click", () => {
      const body = header.nextElementSibling;
      const arrow = header.querySelector(".accordion-arrow");
      if (body && body.classList.contains("accordion-body")) {
        body.classList.toggle("open");
        if (arrow) arrow.classList.toggle("open");
      }
    });
  });

  /* ════════════════════════════════════
     ROOM PAGE (room.html?id=xxx) — swipe, arrows, keyboard
     ════════════════════════════════════ */
  const roomPanel = document.getElementById("roomPanel");
  if (roomPanel) {
    const ROOM_ORDER = ["living", "bedroom", "kitchen", "bathroom", "hallway", "garage"];

    const params = new URLSearchParams(window.location.search);
    let currentRoomId = params.get("id") || "living";

    const iconEl = document.getElementById("rpIcon");
    const nameEl = document.getElementById("rpName");
    const subEl = document.getElementById("rpSub");
    const bulbWrapper = document.getElementById("rpBulbWrapper");
    const bulbGlass = document.getElementById("rpBulbGlass");
    const bulbGlow = document.getElementById("rpBulbGlow");
    const statusDot = document.getElementById("rpStatusDot");
    const statusText = document.getElementById("rpStatusText");
    const toggleBtn = document.getElementById("rpToggle");
    const toggleLabel = document.getElementById("rpToggleLabel");
    const filaments = document.querySelectorAll("#rpBulbWrapper .bulb-filament");
    const knobEl = document.getElementById("rpKnob");
    const rpPrevBtn = document.getElementById("rpPrevBtn");
    const rpNextBtn = document.getElementById("rpNextBtn");
    const rpCounter = document.getElementById("rpCounter");

    let rpIsOn = false;
    let rpBrightness = 0;

    function loadRoomState(id) {
      const s = rooms[id] || { on: false, brightness: 0 };
      rpIsOn = s.on;
      rpBrightness = s.brightness;
    }

    function saveCurrentRoom() {
      rooms[currentRoomId] = { on: rpIsOn, brightness: rpBrightness };
      saveRooms(rooms);
    }

    function setRoomLabels(id) {
      if (iconEl) iconEl.innerHTML = ROOM_ICONS[id] || "&#127968;";
      if (nameEl) nameEl.textContent = ROOM_NAMES[id] || id;
      if (subEl) subEl.textContent = "Adjust your " + (ROOM_NAMES[id] || id) + " light";
      document.title = "Nather — " + (ROOM_NAMES[id] || id);
    }

    function syncUI() {
      if (toggleBtn) toggleBtn.classList.toggle("on", rpIsOn);
      renderBulb(bulbGlass, bulbGlow, rpIsOn, rpBrightness);
      if (statusDot) statusDot.classList.toggle("on", rpIsOn);
      filaments.forEach(f => { f.style.opacity = rpIsOn ? "1" : "0.3"; });
      if (statusText) statusText.textContent = rpIsOn ? "On" : "Off";
      if (toggleLabel) toggleLabel.textContent = rpIsOn ? "ON" : "OFF";
      if (rpKnob) rpKnob.setValue(rpBrightness);
    }

    function updateRoomCounter() {
      const idx = ROOM_ORDER.indexOf(currentRoomId);
      if (rpCounter) rpCounter.textContent = (idx + 1) + " / " + ROOM_ORDER.length;
      if (rpPrevBtn) rpPrevBtn.disabled = idx === 0;
      if (rpNextBtn) rpNextBtn.disabled = idx === ROOM_ORDER.length - 1;
    }

    function switchToRoom(id) {
      if (id === currentRoomId) return;
      saveCurrentRoom();
      currentRoomId = id;
      loadRoomState(id);
      setRoomLabels(id);
      syncUI();
      history.replaceState(null, "", "?id=" + id);
      updateRoomCounter();
      if (rpIsOn) pulseBulb(bulbWrapper);
    }

    loadRoomState(currentRoomId);
    setRoomLabels(currentRoomId);
    updateRoomCounter();

    let rpKnob = null;
    if (knobEl) {
      rpKnob = createKnob(knobEl, {
        initialValue: rpBrightness,
        onChange: (v, dragging) => {
          rpBrightness = v;
          rpIsOn = v > 0;
          syncUI();
          saveCurrentRoom();
          if (rpIsOn && !dragging) pulseBulb(bulbWrapper);
        }
      });
    }

    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        if (rpIsOn) {
          rpIsOn = false;
          rpBrightness = 0;
          if (rpKnob) rpKnob.setValue(0);
          syncUI();
          saveCurrentRoom();
        } else {
          rpIsOn = true;
          rpBrightness = rpBrightness || 50;
          if (rpKnob) rpKnob.setValue(rpBrightness);
          syncUI();
          saveCurrentRoom();
          pulseBulb(bulbWrapper);
        }
      });
    }

    if (rpIsOn) {
      syncUI();
      pulseBulb(bulbWrapper);
    }

    /* ─── ROOM TRANSITION ENGINE ─── */

    let rSwipe = { startX: 0, deltaX: 0, swiping: false, animating: false };

    /* Slides the panel in from the correct side after content has been swapped.
       Called after the slide-out animation finishes (from either touch or buttons). */
    function slideInRoom(dir, targetId) {
      rSwipe.animating = true;
      roomPanel.style.pointerEvents = "none";

      const slideDir = dir === "next" ? "left" : "right";
      const inT = 300;

      switchToRoom(targetId);

      roomPanel.style.transition = "none";
      roomPanel.style.transform = "translateX(" + (slideDir === "left" ? "" : "-") + "100%)";
      roomPanel.style.opacity = "0";
      void roomPanel.offsetWidth;

      roomPanel.style.transition = "transform " + inT + "ms cubic-bezier(0.22,1,0.36,1), opacity " + inT + "ms ease";
      roomPanel.style.transform = "translateX(0)";
      roomPanel.style.opacity = "1";

      setTimeout(() => {
        roomPanel.style.transition = "";
        roomPanel.style.pointerEvents = "";
        rSwipe = { startX: 0, deltaX: 0, swiping: false, animating: false };
      }, inT + 30);
    }

    /* Full transition for buttons / keyboard: slide out, then slide in. */
    function transitionRoom(dir, targetId) {
      if (rSwipe.animating) return;
      rSwipe.animating = true;
      roomPanel.style.pointerEvents = "none";

      const slideDir = dir === "next" ? "left" : "right";
      const outT = 220;

      roomPanel.style.transition = "transform " + outT + "ms cubic-bezier(0.22,1,0.36,1), opacity " + outT + "ms ease";
      roomPanel.style.transform = "translateX(" + (slideDir === "left" ? "-" : "") + "100%)";
      roomPanel.style.opacity = "0";

      setTimeout(() => {
        rSwipe.animating = false;
        slideInRoom(dir, targetId);
      }, outT);
    }

    /* ─── TOUCH SWIPE — finger follows ─── */

    document.addEventListener("touchstart", (e) => {
      if (rSwipe.animating) return;
      if (e.target.closest(".knob-container") || e.target.closest(".toggle") ||
          e.target.closest(".navbar") || e.target.closest("a") ||
          e.target.closest(".rp-nav-btn")) return;
      rSwipe.startX = e.touches[0].clientX;
      rSwipe.deltaX = 0;
      rSwipe.swiping = false;
    }, { passive: true });

    document.addEventListener("touchmove", (e) => {
      if (rSwipe.animating) return;
      if (!rSwipe.startX) return;

      const dx = e.touches[0].clientX - rSwipe.startX;

      if (!rSwipe.swiping && Math.abs(dx) > 12) {
        rSwipe.swiping = true;
      }
      if (!rSwipe.swiping) return;
      e.preventDefault();

      const idx = ROOM_ORDER.indexOf(currentRoomId);
      let bounded = dx;
      if (idx === 0 && dx > 0) bounded = dx * 0.2;
      if (idx === ROOM_ORDER.length - 1 && dx < 0) bounded = dx * 0.2;

      rSwipe.deltaX = bounded;
      roomPanel.style.transition = "none";
      roomPanel.style.transform = "translateX(" + bounded + "px)";
      roomPanel.style.opacity = Math.max(0.5, 1 - Math.abs(bounded) / 500);
    }, { passive: false });

    document.addEventListener("touchend", (e) => {
      if (rSwipe.animating) return;
      if (!rSwipe.swiping) {
        rSwipe.startX = 0;
        roomPanel.style.transition = "";
        roomPanel.style.transform = "";
        roomPanel.style.opacity = "";
        return;
      }

      const dx = rSwipe.deltaX;
      const idx = ROOM_ORDER.indexOf(currentRoomId);
      const threshold = 80;

      if (dx < -threshold && idx < ROOM_ORDER.length - 1) {
        rSwipe.animating = true;
        roomPanel.style.pointerEvents = "none";
        roomPanel.style.transition = "transform 0.2s cubic-bezier(0.22,1,0.36,1), opacity 0.2s ease";
        roomPanel.style.transform = "translateX(-100%)";
        roomPanel.style.opacity = "0";
        setTimeout(() => {
          rSwipe.animating = false;
          slideInRoom("next", ROOM_ORDER[idx + 1]);
        }, 220);
      } else if (dx > threshold && idx > 0) {
        rSwipe.animating = true;
        roomPanel.style.pointerEvents = "none";
        roomPanel.style.transition = "transform 0.2s cubic-bezier(0.22,1,0.36,1), opacity 0.2s ease";
        roomPanel.style.transform = "translateX(100%)";
        roomPanel.style.opacity = "0";
        setTimeout(() => {
          rSwipe.animating = false;
          slideInRoom("prev", ROOM_ORDER[idx - 1]);
        }, 220);
      } else {
        roomPanel.style.transition = "transform 0.35s cubic-bezier(0.22,1,0.36,1), opacity 0.3s ease";
        roomPanel.style.transform = "translateX(0)";
        roomPanel.style.opacity = "1";
        setTimeout(() => {
          roomPanel.style.transition = "";
          rSwipe = { startX: 0, deltaX: 0, swiping: false, animating: false };
        }, 380);
      }
    });

    /* ─── ARROW BUTTONS ─── */

    if (rpPrevBtn) {
      rpPrevBtn.addEventListener("click", () => {
        const idx = ROOM_ORDER.indexOf(currentRoomId);
        if (idx > 0) transitionRoom("prev", ROOM_ORDER[idx - 1]);
      });
    }

    if (rpNextBtn) {
      rpNextBtn.addEventListener("click", () => {
        const idx = ROOM_ORDER.indexOf(currentRoomId);
        if (idx < ROOM_ORDER.length - 1) transitionRoom("next", ROOM_ORDER[idx + 1]);
      });
    }

    /* ─── KEYBOARD ARROW KEYS ─── */

    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      const idx = ROOM_ORDER.indexOf(currentRoomId);
      if (e.key === "ArrowLeft" && idx > 0) {
        e.preventDefault();
        transitionRoom("prev", ROOM_ORDER[idx - 1]);
      }
      if (e.key === "ArrowRight" && idx < ROOM_ORDER.length - 1) {
        e.preventDefault();
        transitionRoom("next", ROOM_ORDER[idx + 1]);
      }
    });
  }

  /* ════════════════════════════════════
     COMPONENT PAGE — carousel
     ════════════════════════════════════ */
  const compTrack = document.getElementById("compCarouselTrack");
  const compPrev = document.getElementById("compCarouselPrev");
  const compNext = document.getElementById("compCarouselNext");
  const compDots = document.getElementById("compCarouselDots");

  if (compTrack) {
    const compIds = ["pir", "led", "esp32", "relay"];
    const params = new URLSearchParams(window.location.search);
    let compCurrent = compIds.indexOf(params.get("id"));
    if (compCurrent < 0) compCurrent = 0;

    /* Build slides from COMPONENTS data */
    compIds.forEach(id => {
      const c = COMPONENTS[id];
      const slide = document.createElement("div");
      slide.className = "comp-carousel-slide";

      const card = document.createElement("div");
      card.className = "comp-detail-card";

      const imgDiv = document.createElement("div");
      imgDiv.className = "comp-detail-image";

      const placeholder = document.createElement("div");
      placeholder.className = "placeholder-icon";
      placeholder.innerHTML = c.icon;

      const img = document.createElement("img");
      img.src = c.image;
      img.alt = c.name;
      img.loading = "lazy";

      img.onload = () => { placeholder.style.display = "none"; };
      img.onerror = () => { img.style.display = "none"; };

      imgDiv.appendChild(placeholder);
      imgDiv.appendChild(img);

      const body = document.createElement("div");
      body.className = "comp-detail-body";

      const badge = document.createElement("span");
      badge.className = "comp-badge";
      badge.textContent = c.badge;

      const name = document.createElement("h2");
      name.textContent = c.name;

      const desc = document.createElement("p");
      desc.className = "comp-desc";
      desc.innerHTML = c.description;

      const specs = document.createElement("div");
      specs.className = "comp-specs";
      c.specs.forEach(s => {
        const item = document.createElement("div");
        item.className = "comp-spec-item";
        item.innerHTML = '<span class="label">' + s.label + '</span><span class="value">' + s.value + '</span>';
        specs.appendChild(item);
      });

      body.appendChild(badge);
      body.appendChild(name);
      body.appendChild(desc);
      body.appendChild(specs);

      card.appendChild(imgDiv);
      card.appendChild(body);
      slide.appendChild(card);
      compTrack.appendChild(slide);
    });

    /* ─── Navigation ─── */

    function compGoTo(index) {
      const changed = index !== compCurrent;
      compCurrent = index;
      compTrack.style.transform = "translateX(-" + (compCurrent * 100) + "%)";
      compRenderDots();
      if (changed) {
        compTrack.style.opacity = "0.75";
        clearTimeout(compTrack._ft);
        compTrack._ft = setTimeout(() => { compTrack.style.opacity = ""; }, 500);
      }
    }

    function compRenderDots() {
      compDots.innerHTML = "";
      compIds.forEach((_, i) => {
        const dot = document.createElement("button");
        dot.className = "gallery-dot" + (i === compCurrent ? " active" : "");
        dot.setAttribute("aria-label", "Go to " + COMPONENTS[compIds[i]].name);
        dot.addEventListener("click", () => compGoTo(i));
        compDots.appendChild(dot);
      });
    }

    function compGoNext() { compGoTo((compCurrent + 1) % compIds.length); }
    function compGoPrev() { compGoTo((compCurrent - 1 + compIds.length) % compIds.length); }

    if (compPrev) compPrev.addEventListener("click", compGoPrev);
    if (compNext) compNext.addEventListener("click", compGoNext);

    /* ─── Swipe ─── */

    const compWrap = compTrack.parentElement;
    let compSX = 0, compDX = 0, compSwiping = false;

    function compSwipeStart(e) {
      compSX = e.touches ? e.touches[0].clientX : e.clientX;
      compDX = 0;
      compSwiping = true;
      compTrack.style.transition = "none";
    }

    function compSwipeMove(e) {
      if (!compSwiping) return;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      compDX = x - compSX;
      compTrack.style.transform = "translateX(calc(-" + (compCurrent * 100) + "% + " + compDX + "px))";
    }

    function compSwipeEnd() {
      if (!compSwiping) return;
      compSwiping = false;
      compTrack.style.transition = "";
      if (Math.abs(compDX) > 50) {
        compDX > 0 ? compGoPrev() : compGoNext();
      } else {
        compGoTo(compCurrent);
      }
    }

    compWrap.addEventListener("touchstart", compSwipeStart, { passive: true });
    compWrap.addEventListener("touchmove", compSwipeMove, { passive: true });
    compWrap.addEventListener("touchend", compSwipeEnd);
    compWrap.addEventListener("mousedown", compSwipeStart);
    compWrap.addEventListener("mousemove", compSwipeMove);
    compWrap.addEventListener("mouseup", compSwipeEnd);
    compWrap.addEventListener("mouseleave", compSwipeEnd);

    /* ─── Keyboard ─── */

    document.addEventListener("keydown", (e) => {
      if (!compTrack) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); compGoPrev(); }
      if (e.key === "ArrowRight") { e.preventDefault(); compGoNext(); }
    });

    compRenderDots();
    compGoTo(compCurrent);
  }

});
