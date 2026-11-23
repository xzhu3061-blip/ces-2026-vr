"use strict";

const byId = id => document.getElementById(id);
const stage = byId("stage");
const viewport = byId("viewer");
const detail = byId("detail");
const tau = 2 * Math.PI;
const minPanoramaWidth = 4096;
const lens = { minFov: 55, maxFov: 95, planetFov: 148, defaultZoom: 40 };
const motionReduced = matchMedia("(prefers-reduced-motion: reduce)");
const tones = ["#c3fc69", "#6be6e4", "#b4a2ff", "#ffbf76"];
const generatedImages = new Map();
const photoTextures = new Map();
let scenes = [], current = null, engine = null, busy = false, queuedScene = null;
let cruising = false, picking = false, selection = null, statusTimer = 0;

function verticalFov(zoom, planet = 0) {
  return lens.maxFov - (lens.maxFov - lens.minFov) * zoom / 100 +
    (lens.planetFov - lens.maxFov) * planet;
}

function notice(message, duration = 0) {
  clearTimeout(statusTimer);
  byId("status").textContent = message;
  byId("status").hidden = !message;
  if (duration) statusTimer = setTimeout(() => notice(""), duration);
}

function updateBearing(yaw) {
  const degrees = ((Math.round(yaw * 180 / Math.PI) % 360) + 360) % 360;
  byId("bearing").value = String(degrees).padStart(3, "0") + "°";
  byId("needle").style.transform = "rotate(" + (-degrees) + "deg)";
  byId("radar-beam").setAttribute("transform", "rotate(" + (yaw * 180 / Math.PI) + ")");
}

function markerButton(spot, pluginHandlesPointer) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "spot " + spot.type;
  button.setAttribute("aria-label", (spot.type === "jump" ? "前往" : "查看") + spot.label);
  const symbol = document.createElement("span");
  symbol.className = spot.type === "jump" ? "jump-icon" : "info-dot";
  symbol.textContent = spot.type === "jump" ? "" : "i";
  symbol.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "spot-label";
  label.textContent = spot.label;
  button.append(symbol, label);
  if (spot.type === "info") {
    const card = document.createElement("span");
    card.className = "spot-preview";
    card.id = "preview-" + spot.id;
    card.setAttribute("role", "tooltip");
    const title = document.createElement("strong"), summary = document.createElement("span");
    title.textContent = spot.title;
    summary.textContent = spot.highlight || (spot.description || "").split(/[。！？]/)[0];
    card.append(title, summary); button.append(card);
    button.setAttribute("aria-describedby", card.id);
    function fitPreview() {
      const bounds = viewport.getBoundingClientRect(), anchor = button.getBoundingClientRect();
      const left = Math.min(bounds.right - card.offsetWidth - 8, Math.max(bounds.left + 8, anchor.x + (anchor.width - card.offsetWidth) / 2));
      card.style.left = (left - anchor.x) + "px";
      card.classList.toggle("below", anchor.top - bounds.top < card.offsetHeight + 12);
    }
    button.addEventListener("pointerenter", fitPreview);
    button.addEventListener("focus", fitPreview);
  }
  button.addEventListener("click", event => {
    if (!pluginHandlesPointer || event.detail === 0) activate(spot);
  });
  return button;
}

// PSV 5.5.2 exposes its UMD plugin constructor inside a second namespace.
function makeSphereViewer() {
  const Plugin = window.PhotoSphereViewer?.MarkersPlugin?.MarkersPlugin;
  if (!window.THREE || !Plugin) return null;
  const viewer = new PhotoSphereViewer.Viewer({
    container: viewport, navbar: false, plugins: [Plugin], keyboard: false,
    defaultYaw: 0, defaultPitch: 0, defaultZoomLvl: lens.defaultZoom,
    minFov: lens.minFov, maxFov: lens.maxFov,
    mousewheel: true, touchmoveTwoFingers: false, loadingTxt: "正在生成视图…",
    adapter: [PhotoSphereViewer.EquirectangularAdapter, { useXmpData: false }]
  });
  const markers = viewer.getPlugin(Plugin);
  let wideLens = false;
  markers.addEventListener("select-marker", e => {
    if (!e.rightClick && !e.doubleClick) activate(e.marker.config.data);
  });
  // Sample the camera ray on pointer release. PSV groups quick clicks into
  // double-clicks, whereas the editor needs to accept each independent tap.
  let pickStart = null;
  const pickEvents = new AbortController();
  viewport.addEventListener("pointerdown", e => {
    pickStart = picking && !busy && e.isPrimary && e.button === 0
      ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null;
  }, { signal: pickEvents.signal });
  viewport.addEventListener("pointerup", e => {
    if (pickStart && picking && !busy && e.pointerId === pickStart.id &&
        Math.hypot(e.clientX - pickStart.x, e.clientY - pickStart.y) < 5) {
      const rect = viewer.container.getBoundingClientRect();
      const point = viewer.dataHelper.viewerCoordsToSphericalCoords({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      if (point) recordPoint(point);
    }
    pickStart = null;
  }, { signal: pickEvents.signal });
  viewport.addEventListener("pointercancel", () => { pickStart = null; }, { signal: pickEvents.signal });
  viewer.addEventListener("position-updated", e => updateBearing(e.position.yaw));
  return {
    async load(url, scene, crossfade = true) {
      const { yaw, pitch, zoom } = scene.initialView;
      await viewer.setPanorama(url, { position: { yaw, pitch }, zoom,
        transition: Boolean(crossfade && current && !motionReduced.matches), speed: 480, showLoader: false });
      markers.setMarkers(scene.hotspots.map(spot => {
        const wrapper = document.createElement("div");
        wrapper.append(markerButton(spot, true));
        return { id: spot.id, element: wrapper, position: { yaw: spot.yaw, pitch: spot.pitch }, data: spot };
      }));
    },
    showMarks(show) { if (show) markers.showAllMarkers(); else markers.hideAllMarkers(); },
    position: () => viewer.getPosition(),
    stopMotion: () => viewer.stopAll(),
    zoomLevel: () => viewer.getZoomLevel(),
    setPose(pose, planet = 0) {
      if (wideLens !== (planet > 0)) {
        wideLens = planet > 0;
        viewer.setOption("maxFov", wideLens ? lens.planetFov : lens.maxFov);
      }
      // At the opposite surface of the sphere the camera approaches stereographic projection.
      if (viewer.config.fisheye || planet) viewer.setOption("fisheye", 1.96 * planet);
      const fov = verticalFov(pose.zoom, planet);
      viewer.zoom(wideLens ? 100 * (lens.planetFov - fov) / (lens.planetFov - lens.minFov) : pose.zoom);
      viewer.rotate(pose);
    },
    rotate: position => viewer.rotate(position),
    zoom: amount => viewer.zoom(viewer.getZoomLevel() + amount),
    reset: view => {
      viewer.stopAnimation();
      if (motionReduced.matches) { viewer.rotate(view); viewer.zoom(view.zoom); }
      else viewer.animate({ ...view, speed: 500 });
    },
    destroy() { pickEvents.abort(); viewer.destroy(); }
  };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = url;
  });
}

// A perspective Canvas renderer also allows a visit when WebGL or the CDN is unavailable.
// The same camera basis is used for painting, projecting markers and picking.
function makeCanvasViewer() {
  const canvas = document.createElement("canvas");
  const overlay = document.createElement("div");
  canvas.className = "surface";
  overlay.className = "surface-marks";
  viewport.replaceChildren(canvas, overlay);
  const ctx = canvas.getContext("2d", { alpha: false });
  let pixels, imageWidth, imageHeight, frame, view = { yaw: 0, pitch: 0, zoom: lens.defaultZoom };
  let spots = [], raf = 0, drag = null, planet = 0;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const focal = h => h / (2 * Math.tan(verticalFov(view.zoom, planet) * Math.PI / 360));
  function camera() {
    return { sy: Math.sin(view.yaw), cy: Math.cos(view.yaw), sp: Math.sin(view.pitch), cp: Math.cos(view.pitch) };
  }
  function ray(x, y, c) {
    // Intersect the offset camera ray with the unit sphere during the planet intro.
    let z = 1;
    if (planet) {
      const k = .98 * planet, lengthSquared = 1 + x * x + y * y;
      const t = (k + Math.sqrt(k * k + lengthSquared * (1 - k * k))) / lengthSquared;
      x *= t; y *= t; z = t - k;
    }
    const forward = z * c.cp - y * c.sp;
    const dx = c.sy * forward + x * c.cy;
    const dz = c.cy * forward - x * c.sy;
    return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(z * c.sp + y * c.cp, Math.hypot(dx, dz)) };
  }
  function paint() {
    raf = 0;
    if (!pixels || !viewport.clientHeight) return;
    const width = viewport.clientWidth, height = viewport.clientHeight;
    const scale = Math.min(1, 1250 / width, 780 / height);
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    if (!frame || canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h; frame = ctx.createImageData(w, h);
    }
    const c = camera(), f = focal(h), out = new Uint32Array(frame.data.buffer);
    // Interpolate within short scanline segments, wrapping seamlessly at the south meridian.
    for (let j = 0; j < h; j++) {
      const y = (h / 2 - j - .5) / f;
      let left = ray((.5 - w / 2) / f, y, c);
      for (let i = 0; i < w; i += 8) {
        const step = Math.min(8, w - i);
        const right = ray((i + step + .5 - w / 2) / f, y, c);
        let dyaw = right.yaw - left.yaw;
        if (dyaw > Math.PI) dyaw -= tau;
        if (dyaw < -Math.PI) dyaw += tau;
        for (let k = 0; k < step; k++) {
          const t = k / step;
          const u = Math.floor((.5 + (left.yaw + dyaw * t) / tau) * imageWidth);
          const v = clamp(Math.floor((.5 - (left.pitch + (right.pitch - left.pitch) * t) / Math.PI) * imageHeight), 0, imageHeight - 1);
          out[j * w + i + k] = pixels[v * imageWidth + (u + imageWidth) % imageWidth];
        }
        left = right;
      }
    }
    ctx.putImageData(frame, 0, 0);
    const screenFocal = focal(height);
    for (const { spot, button } of spots) {
      const delta = spot.yaw - view.yaw, cp = Math.cos(spot.pitch), sp = Math.sin(spot.pitch);
      const a = cp * Math.cos(delta), z = a * c.cp + sp * c.sp;
      const x = width / 2 + screenFocal * cp * Math.sin(delta) / z;
      const y = height / 2 - screenFocal * (sp * c.cp - a * c.sp) / z;
      button.hidden = z < .01 || x < 0 || x > width || y < 0 || y > height;
      button.style.left = x + "px"; button.style.top = y + "px";
    }
    updateBearing(view.yaw);
  }
  function repaint() { if (!raf) raf = requestAnimationFrame(paint); }
  function rotate(next) {
    view.yaw = next.yaw % tau; view.pitch = clamp(next.pitch, -Math.PI / 2, Math.PI / 2);
    repaint();
  }
  function zoom(amount) { view.zoom = clamp(view.zoom + amount, 0, 100); repaint(); }
  canvas.addEventListener("pointerdown", e => {
    if (busy || e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ...view, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", e => {
    if (e.pointerId !== drag?.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.moved) rotate({ yaw: drag.yaw - dx / focal(canvas.clientHeight), pitch: drag.pitch + dy / focal(canvas.clientHeight) });
  });
  canvas.addEventListener("pointerup", e => {
    if (e.pointerId !== drag?.id) return;
    if (picking && !busy && !drag.moved) {
      const rect = canvas.getBoundingClientRect(), f = focal(rect.height);
      recordPoint(ray((e.clientX - rect.left - rect.width / 2) / f, (rect.height / 2 - e.clientY + rect.top) / f, camera()));
    }
    drag = null;
  });
  canvas.addEventListener("pointercancel", () => { drag = null; });
  canvas.addEventListener("wheel", e => { e.preventDefault(); zoom(-Math.sign(e.deltaY) * 4); }, { passive: false });
  const observer = new ResizeObserver(repaint);
  observer.observe(viewport);
  return {
    async load(url, scene, crossfade = true) {
      const img = await loadImage(url);
      const texture = document.createElement("canvas");
      // The CPU fallback keeps a full RGBA raster in memory.
      imageWidth = texture.width = Math.min(minPanoramaWidth, img.naturalWidth);
      imageHeight = texture.height = Math.max(1, Math.round(img.naturalHeight * imageWidth / img.naturalWidth));
      const g = texture.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0, imageWidth, imageHeight);
      pixels = new Uint32Array(g.getImageData(0, 0, imageWidth, imageHeight).data.buffer);
      texture.width = texture.height = 1;
      view = { ...scene.initialView };
      spots = scene.hotspots.map(spot => ({ spot, button: markerButton(spot, false) }));
      overlay.replaceChildren(...spots.map(item => item.button)); paint();
      if (crossfade && current && !motionReduced.matches) canvas.animate([{ opacity: .2 }, { opacity: 1 }], { duration: 350 });
    },
    showMarks(show) { overlay.hidden = !show; },
    position: () => ({ yaw: view.yaw, pitch: view.pitch }), rotate, zoom,
    zoomLevel: () => view.zoom,
    setPose(pose, distortion = 0) { view = { ...pose }; planet = distortion; repaint(); },
    reset(initial) { view = { ...initial }; repaint(); },
    destroy() { observer.disconnect(); cancelAnimationFrame(raf); viewport.replaceChildren(); }
  };
}

async function generatedUrl(scene) {
  if (generatedImages.has(scene.id)) return generatedImages.get(scene.id);
  const canvas = createHallPanorama(scene, scenes.indexOf(scene));
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .98));
  if (!blob) throw new Error("全景图编码失败");
  const url = URL.createObjectURL(blob);
  canvas.width = canvas.height = 1;
  generatedImages.set(scene.id, url);
  return url;
}

async function preprocessPanorama(image) {
  const canvas = document.createElement("canvas");
  // Round odd widths up by one pixel so the normalized texture stays exactly 2:1.
  const width = canvas.width = Math.max(minPanoramaWidth, Math.ceil(image.naturalWidth / 2) * 2);
  const height = canvas.height = width / 2;
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  try {
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, width, height);
    const band = Math.round(width * .03);
    const left = ctx.getImageData(0, 0, band, height);
    const right = ctx.getImageData(width - band, 0, band, height);
    for (let x = 0; x < band; x++) {
      const t = x / (band - 1);
      const weight = .5 * (1 - t * t * (3 - 2 * t));
      for (let y = 0; y < height; y++) {
        const a = 4 * (y * band + x), b = 4 * (y * band + band - 1 - x);
        for (let ch = 0; ch < 3; ch++) {
          const delta = (right.data[b + ch] - left.data[a + ch]) * weight;
          left.data[a + ch] += delta; right.data[b + ch] -= delta;
        }
      }
    }
    ctx.putImageData(left, 0, 0); ctx.putImageData(right, width - band, 0);
    // Lossless output preserves identical pixel columns across the wrap boundary.
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("无法编码全景纹理");
    return URL.createObjectURL(blob);
  } finally { canvas.width = canvas.height = 1; }
}

async function panoramaUrl(scene) {
  if (scene.panorama) {
    try {
      if (!photoTextures.has(scene.panorama)) {
        const texture = await preprocessPanorama(await loadImage(scene.panorama));
        photoTextures.set(scene.panorama, texture);
      }
      return photoTextures.get(scene.panorama);
    }
    catch { /* A missing or inaccessible asset uses the generated room. */ }
  }
  return generatedUrl(scene);
}

function setCruise(on) {
  cruising = Boolean(on && current && !picking && !detail.open);
  byId("cruise").setAttribute("aria-pressed", cruising);
}

let lastFrame = 0, cruiseFrame = 0;
function cruiseStep(time) {
  if (cruising && !busy && !document.hidden && lastFrame) {
    const p = engine.position();
    engine.rotate({ yaw: p.yaw + Math.min(time - lastFrame, 80) * .000065, pitch: p.pitch });
  }
  lastFrame = time;
  cruiseFrame = cruising ? requestAnimationFrame(cruiseStep) : 0;
}

function clearPoint() {
  selection = null; byId("yaw").value = byId("pitch").value = "—";
  byId("copy").disabled = true; byId("manual-copy").hidden = true;
  byId("pick-hint").textContent = "点击全景画面记录坐标";
}
function togglePick(on) {
  if (!current || busy) return;
  picking = on; setCruise(false); clearPoint();
  stage.classList.toggle("picking", on);
  byId("pick").setAttribute("aria-pressed", on);
  byId("picker").hidden = !on; engine.showMarks(!on);
}
function recordPoint(p) {
  // Signed radians, normalized into [-π, π).
  const yaw = ((p.yaw + Math.PI) % tau + tau) % tau - Math.PI;
  const yawText = yaw.toFixed(4), pitchText = p.pitch.toFixed(4);
  selection = { yaw: Number(yawText), pitch: Number(pitchText) };
  byId("yaw").value = yawText; byId("pitch").value = pitchText;
  byId("copy").disabled = false; byId("manual-copy").hidden = true;
  byId("pick-hint").textContent = "已记录，可继续点击调整位置";
}
async function copyPoint() {
  if (!selection) return;
  const point = { id: "spot-" + Date.now().toString(36), type: "info", label: "新展品", ...selection,
    brand: "", title: "新展品", highlight: "", tags: [], description: "", image: "" };
  const json = JSON.stringify(point, null, 2);
  try { await navigator.clipboard.writeText(json); }
  catch {
    const field = byId("manual-copy");
    field.hidden = false; field.value = json; field.focus(); field.select();
    if (!document.execCommand("copy")) { byId("pick-hint").textContent = "请复制下方已选中的 JSON"; return; }
    field.hidden = true;
  }
  byId("pick-hint").textContent = "热点 JSON 已复制";
}

const speech = window.speechSynthesis;
const canNarrate = Boolean(speech && window.SpeechSynthesisUtterance);
let narration = null, narrationPaused = false;
function speechNote(message = "") {
  byId("speech-note").textContent = message;
  byId("speech-note").hidden = !message;
}
function stopNarration() {
  if (narration) { narration = null; speech.cancel(); }
  narrationPaused = false;
  byId("narrate").textContent = "AI 语音讲解";
}
byId("narrate").onclick = () => {
  if (!canNarrate || !detail.open) return;
  if (narration) {
    // Some voices acknowledge pause asynchronously, especially while starting.
    narrationPaused = !narrationPaused;
    if (narrationPaused) speech.pause(); else speech.resume();
    byId("narrate").textContent = narrationPaused ? "继续讲解" : "暂停讲解";
    return;
  }
  speechNote();
  const utterance = new SpeechSynthesisUtterance(byId("description").textContent);
  utterance.lang = "zh-CN";
  const voices = speech.getVoices();
  const chinese = voices.filter(v => /^zh/i.test(v.lang));
  const voice = chinese.find(v => v.localService && /^zh[-_]CN/i.test(v.lang)) ||
    chinese.find(v => /^zh[-_]CN/i.test(v.lang)) || chinese[0];
  if (voice) utterance.voice = voice;
  utterance.onstart = () => { if (narration === utterance && narrationPaused) speech.pause(); };
  utterance.onend = utterance.onerror = e => {
    if (narration !== utterance) return;
    narration = null; narrationPaused = false; byId("narrate").textContent = "AI 语音讲解";
    if (e.type === "error") speechNote("此设备暂时无法朗读，可检查系统中文语音后重试。");
  };
  narration = utterance;
  if (speech.paused) speech.resume();
  speech.speak(utterance); byId("narrate").textContent = "暂停讲解";
};
detail.addEventListener("close", stopNarration);
window.addEventListener("pagehide", stopNarration);

function openExhibit(spot) {
  setCruise(false);
  stopNarration();
  byId("narrate").disabled = !canNarrate;
  speechNote(canNarrate ? "" : "当前浏览器未提供语音朗读功能。");
  byId("detail-brand").textContent = spot.brand;
  byId("detail-title").textContent = spot.title;
  byId("description").textContent = spot.description;
  byId("tags").replaceChildren(...spot.tags.map(tag => {
    const item = document.createElement("span"); item.textContent = tag; return item;
  }));
  byId("source").hidden = !spot.source;
  if (spot.source) byId("source").href = spot.source;
  byId("placeholder-name").textContent = spot.title;
  byId("placeholder-code").textContent = current.english.toUpperCase();
  const oldPhoto = byId("photo"), photo = new Image();
  photo.id = "photo"; photo.alt = spot.title; photo.hidden = true;
  byId("placeholder").hidden = false; oldPhoto.replaceWith(photo);
  photo.onload = () => {
    if (!photo.isConnected) return;
    photo.hidden = false; byId("placeholder").hidden = true;
  };
  photo.onerror = () => { photo.hidden = true; };
  if (spot.image) photo.src = spot.image;
  detail.showModal(); byId("close").focus();
}

function activate(spot) {
  if (picking || busy || detail.open) return;
  if (spot.type === "jump") changeScene(spot.target, spot);
  else openExhibit(spot);
}

function makeDirectory() {
  scenes.forEach((scene, index) => {
    const button = document.createElement("button");
    button.className = "hall-card"; button.dataset.id = scene.id;
    button.style.setProperty("--tone", tones[index]);
    button.innerHTML = '<span class="card-art"><canvas aria-hidden="true"></canvas><span class="hall-no"></span><span class="here">当前展馆</span></span><span class="card-copy"><strong></strong><small></small></span>';
    button.querySelector(".hall-no").textContent = "HALL " + String(index + 1).padStart(2, "0");
    button.querySelector("strong").textContent = scene.name;
    button.querySelector("small").textContent = scene.english.toUpperCase();
    drawHallThumbnail(button.querySelector("canvas"), index);
    button.addEventListener("click", () => changeScene(scene.id));
    byId("cards").append(button);
  });
}

function setMapOpen(open) {
  byId("map-toggle").setAttribute("aria-expanded", open);
  byId("map-plan").toggleAttribute("hidden", !open);
}
byId("map-toggle").onclick = () => setMapOpen(byId("map-toggle").getAttribute("aria-expanded") !== "true");
setMapOpen(!matchMedia("(max-width: 680px), (max-height: 540px)").matches);
const mapPoints = document.querySelectorAll(".map-point");
for (const point of mapPoints) {
  point.addEventListener("click", () => changeScene(point.dataset.hall));
  point.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); changeScene(point.dataset.hall); }
  });
}
function updateMap(scene) {
  for (const point of mapPoints) {
    const active = point.dataset.hall === scene.id;
    point.setAttribute("aria-current", active ? "location" : "false");
    if (active) byId("radar-origin").setAttribute("transform", point.getAttribute("transform"));
  }
  updateBearing(engine.position().yaw);
}

// Run each move to its exact final pose, including when a reduced-motion
// preference changes or a visitor selects another hall mid-transition.
function tween(duration, render) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    function step(now) {
      const t = motionReduced.matches || queuedScene ? 1 : Math.min(1, Math.max(0, (now - start) / duration));
      try { render(t * t * (3 - 2 * t)); }
      catch (error) { reject(error); return; }
      if (t === 1) resolve(); else requestAnimationFrame(step);
    }
    step(start);
  });
}
async function approach(spot) {
  const from = engine.position(), zoom = engine.zoomLevel();
  const yawDelta = Math.atan2(Math.sin(spot.yaw - from.yaw), Math.cos(spot.yaw - from.yaw));
  await tween(420, t => {
    engine.setPose({ yaw: from.yaw + yawDelta * t, pitch: from.pitch + (spot.pitch - from.pitch) * t,
      zoom: zoom + (Math.min(100, zoom + 12) - zoom) * t });
    byId("travel-shade").style.opacity = String(Math.max(0, (t - .36) / .64));
  });
}
async function planetIntro(view) {
  await tween(1800, t => {
    engine.setPose({ yaw: view.yaw - 1.15 * (1 - t), pitch: -Math.PI / 2 + (view.pitch + Math.PI / 2) * t,
      zoom: view.zoom * t }, 1 - t);
  });
}

async function changeScene(id, entrance = null) {
  const scene = scenes.find(item => item.id === id);
  if (!scene) return;
  if (busy) { queuedScene = id; return; }
  if (current === scene) return;
  const opening = !current && id === "hall_intro" && !motionReduced.matches;
  const travel = Boolean(entrance && !motionReduced.matches);
  busy = true; setCruise(false); clearPoint();
  if (current) engine.stopMotion?.();
  viewport.inert = true;
  engine.showMarks(false);
  viewport.setAttribute("aria-busy", "true");
  notice("正在进入" + scene.name + "…");
  try {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const [url] = await Promise.all([panoramaUrl(scene), travel ? approach(entrance) : null]);
    try { await engine.load(url, scene, !travel); }
    catch {
      // If the GPU could not upload the texture, keep the real photo in the CPU renderer.
      engine.destroy(); engine = makeCanvasViewer(); engine.showMarks(false);
      try { await engine.load(url, scene, false); }
      catch { await engine.load(await generatedUrl(scene), scene, false); }
    }
    current = scene;
    updateMap(scene);
    byId("hall-name").textContent = byId("crumb").textContent = scene.name;
    byId("theme").textContent = scene.theme;
    byId("hall-number").textContent = String(scenes.indexOf(scene) + 1).padStart(2, "0");
    for (const button of byId("cards").children) {
      const active = button.dataset.id === id;
      button.setAttribute("aria-current", active);
      if (active && byId("cards").scrollWidth > byId("cards").clientWidth) {
        byId("cards").scrollTo({ left: button.offsetLeft - byId("cards").offsetLeft, behavior: motionReduced.matches ? "instant" : "smooth" });
      }
    }
    notice("");
    if (opening) await planetIntro(scene.initialView);
    if (travel) await tween(300, t => { byId("travel-shade").style.opacity = String(1 - t); });
  } catch (error) {
    notice("展馆加载失败，可点击展馆卡片重试。"); console.error(error);
  } finally {
    viewport.inert = false;
    byId("travel-shade").style.opacity = "0";
    engine.showMarks(!picking); busy = false; viewport.setAttribute("aria-busy", "false");
    if (queuedScene) {
      const next = queuedScene; queuedScene = null; changeScene(next);
    }
  }
}

byId("cruise").onclick = () => {
  if (busy || !current) return;
  if (picking) togglePick(false);
  setCruise(!cruising);
  if (cruising && !cruiseFrame) { lastFrame = 0; cruiseFrame = requestAnimationFrame(cruiseStep); }
};
byId("reset").onclick = () => { if (current && !busy) { setCruise(false); engine.reset(current.initialView); } };
byId("pick").onclick = () => togglePick(!picking);
byId("copy").onclick = copyPoint;
viewport.addEventListener("pointerdown", () => setCruise(false), true);
viewport.addEventListener("wheel", () => setCruise(false), { passive: true });
byId("collapse").onclick = () => {
  const folded = document.querySelector(".directory").classList.toggle("fold");
  byId("cards").hidden = folded;
  byId("collapse").setAttribute("aria-expanded", !folded);
  byId("collapse").querySelector("span").textContent = folded ? "展开" : "收起";
};
byId("full").onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { notice("当前浏览器未开放全屏功能", 2600); }
};
document.addEventListener("fullscreenchange", () => byId("full").setAttribute("aria-pressed", Boolean(document.fullscreenElement)));
byId("close").onclick = () => detail.close();
detail.onclick = e => { if (e.target === detail) detail.close(); };
document.addEventListener("keydown", e => {
  if (detail.open || !current || busy || e.altKey || e.ctrlKey || e.metaKey || e.target.matches("input,textarea,[contenteditable=true]")) return;
  if (e.code === "KeyD" && !e.repeat) { e.preventDefault(); togglePick(!picking); }
  if (e.code === "Escape" && picking) togglePick(false);
  if (viewport.contains(e.target) && e.key.startsWith("Arrow")) {
    e.preventDefault(); setCruise(false);
    const p = engine.position(), step = .08;
    if (e.key === "ArrowRight") p.yaw += step;
    if (e.key === "ArrowLeft") p.yaw -= step;
    if (e.key === "ArrowUp") p.pitch += step;
    if (e.key === "ArrowDown") p.pitch -= step;
    engine.rotate(p);
  }
});

async function start() {
  try {
    const response = await fetch("data/scenes.json");
    if (!response.ok) throw new Error("无法读取展馆配置");
    ({ scenes } = await response.json());
    makeDirectory();
    try { engine = makeSphereViewer(); } catch { viewport.replaceChildren(); }
    if (!engine) engine = makeCanvasViewer();
    await changeScene(scenes[0].id);
  } catch (error) {
    notice("无法打开展厅，请按 README 使用本地静态服务器启动，并检查 scenes.json。");
    console.error(error);
  }
}

start();

/* Bake an equirectangular photograph of a procedural room. The six architectural
   surfaces are drawn once, then sampled by direction. Furniture is projected
   into that same coordinate system, so even the seam and the poles line up. */
function createHallPanorama(scene, index = 0) {
  const W = 4096, H = 2048, SIDE = 1536, WALL = 2048, WALL_H = 576;
  const radius = 20, roof = 8.55, floor = -2.7, tau = Math.PI * 2;
  const palette = [
    ['#c6fa52', '#00d4ff'], ['#a6ff74', '#14d9e5'],
    ['#b89aff', '#4bd7ff'], ['#ffb36e', '#58dcff']
  ][index % 4];
  const [accent, blue] = palette;
  const english = ['CENTRAL ATRIUM', 'PHYSICAL AI', 'FUTURE DISPLAY', 'SMART MOBILITY'][index % 4];
  const directions = ['北（主舞台方向）', '东', '南', '西'];
  const make = (w, h) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    return canvas;
  };
  const result = make(W, H);
  const view = result.getContext('2d', { alpha: false });
  let seed = 6169 + index;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  function rect(g, x, y, w, h, color) {
    g.fillStyle = color; g.fillRect(x, y, w, h);
  }
  function line(g, x1, y1, x2, y2, color, width = 1) {
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2);
    g.lineWidth = width; g.strokeStyle = color; g.stroke();
  }
  function gradient(g, x1, y1, x2, y2, stops) {
    const fill = g.createLinearGradient(x1, y1, x2, y2);
    stops.forEach(([at, color]) => fill.addColorStop(at, color));
    return fill;
  }
  function glow(g, x, y, rx, ry, color) {
    g.save(); g.translate(x, y); g.scale(rx, ry);
    const halo = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    halo.addColorStop(0, color); halo.addColorStop(1, 'transparent');
    rect(g, -1, -1, 2, 2, halo); g.restore();
  }
  function text(g, words, x, y, font, color, align = 'left') {
    g.font = font; g.fillStyle = color; g.textAlign = align; g.fillText(words, x, y);
  }
  function stripe(g, x, y, w, h, color) {
    g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
    for (let i = -h; i < w; i += 10) line(g, x+i, y+h, x+i+h, y, color, 3);
    g.restore();
  }
  function wallTexture(side) {
    const g = make(WALL, WALL_H).getContext('2d', {willReadFrequently: true});
    rect(g, 0, 0, WALL, WALL_H, gradient(g, 0, 0, 0, WALL_H,
      [[0,'#0a131b'],[.18,'#344451'],[.42,'#22333e'],[.83,'#162b37'],[1,'#07141f']]));
    // Extruded steel wall bays with closely spaced acoustic fins.
    for (let x = 0; x < WALL; x += 64) {
      rect(g, x+1, 62, 61, 476, gradient(g, x,0,x+64,0,
        [[0,'#334450'],[.12,'#182935'],[.88,'#182730'],[1,'#44525a']]));
      for (let i=6; i<61; i+=7) rect(g,x+i,65,2,460,'#101f29');
      rect(g,x+2,525,60,7,'#3c4e58');
    }
    rect(g,0,63,WALL,6,'#60727a'); rect(g,0,70,WALL,9,'#0b161e');
    // A steel lattice crowns the continuous perimeter.
    for (let x=-64;x<WALL;x+=76) {
      line(g,x,57,x+47,6,'#080f16',11); line(g,x,55,x+47,4,'#53616b',3);
      line(g,x+47,6,x+76,56,'#17212b',8);
    }
    for (const x of [74,310,522,1516,1728,1964]) {
      rect(g,x,78,16,449,'#070f17'); rect(g,x+2,80,4,438,'#73848b');
      rect(g,x-3,102,2,239,'#68b0c2');
      rect(g,x-10,520,34,42,'#203541');
    }
    // Large LED wall, its bezel, glass fascia and recessed stage lighting.
    const x0=551,y0=120,sw=946,sh=310;
    glow(g,1024,245,720,215,'rgba(0,179,224,.48)');
    rect(g,x0-16,y0-14,sw+32,sh+36,'#0b141d');
    rect(g,x0-13,y0-13,sw+26,4,'#8aadb5');
    rect(g,x0-7,y0-7,sw+14,sh+14,'#213e49');
    rect(g,x0,y0,sw,sh,gradient(g,x0,y0,x0+sw,y0+sh,
      [[0,'#124450'],[.28,'#0b2b3c'],[.67,'#0a202f'],[1,'#164e5d']]));
    g.save(); g.beginPath(); g.rect(x0,y0,sw,sh); g.clip();
    glow(g,1410,240,310,230,'rgba(31,235,232,.38)');
    for(let x=x0+12;x<x0+sw;x+=14) for(let y=y0+8;y<y0+sh;y+=14) {
      rect(g,x,y,1.3,1.3,'rgba(159,234,237,.38)');
    }
    // A luminous topographic torus wraps around the right of the main graphic.
    for(let i=0;i<66;i++) {
      const q=i/65;
      g.beginPath(); g.ellipse(1362+50*Math.sin(q*5+index),275+34*q,168-50*q,
        49+97*q,-.57+q*.57,0,tau);
      g.strokeStyle=i%7===0?accent:'rgba(70,234,223,.66)'; g.lineWidth=i%7===0?1.7:1; g.stroke();
    }
    for(let i=0;i<4;i++) line(g,x0+28+i*7,y0+21,x0+32+i*7,y0+12,accent,3);
    text(g,'CES  /  LAS VEGAS',x0+67,y0+23,'600 12px Arial','#ccedf0');
    text(g,side===0?'CES 2026':english,x0+49,y0+165,
      side===0?'italic 900 112px Arial, sans-serif':'italic 900 66px Arial, sans-serif','#f5fbfa');
    text(g,scene.name,x0+57,y0+219,'600 36px "Microsoft YaHei", sans-serif','#d2f1f4');
    text(g,side===0 && index===0?'AI 融入物理世界':english,x0+59,y0+254,
      '500 19px Arial, "Microsoft YaHei", sans-serif', '#8ecad1');
    rect(g,x0,y0+sh-4,sw,4,blue); g.restore();
    for (let i=0;i<3;i++) {
      rect(g,527-i*12,448+i*19,994+i*24,18,gradient(g,0,448+i*19,0,466+i*19,
        [[0,'#527480'],[.18,'#344854'],[.3,'#152633'],[1,'#0a1b23']]));
      rect(g,537-i*12,449+i*19,974+i*24,1.8,i===0?blue:'#628d9d');
    }
    // Side billboards and smaller service/access doors.
    for(const [sign,x] of [[-1,132],[1,1580]]) {
      rect(g,x,169,322,228,'#0c1923'); rect(g,x+3,172,316,4,'#a3bfca');
      rect(g,x+7,178,308,205,gradient(g,x,178,x+315,383,[[0,'#173843'],[1,'#0a202d']]));
      glow(g,x+220,262,121,88,'rgba(18,225,241,.2)');
      for(let i=0;i<26;i++){
        g.beginPath(); g.ellipse(x+155+Math.cos(i/15)*25,260+i*.6,
          77+i*.65,16+i*1.4,sign*.48,0,tau); g.strokeStyle=i%5===0?accent:'#5597a6'; g.stroke();
      }
      text(g,english,x+19,357,'bold 21px Arial','#e5f6f6');
      text(g,'CES 2026',x+20,377,'11px monospace','#9fc4cc');
      rect(g,x,418,322,25,'#101e26'); stripe(g,x+225,424,74,8,accent);
      for(let i=0;i<7;i++) rect(g,x+10+i*24,461,13,2,'#a9e5ea');
    }
    text(g,directions[side],1024,101,'bold 17px "Microsoft YaHei", sans-serif','#dff9ff','center');
    return g.getImageData(0,0,WALL,WALL_H);
  }
  function horizontalTexture(ceiling) {
    const g=make(SIDE,SIDE).getContext('2d',{willReadFrequently:true});
    const mid=SIDE/2;
    rect(g,0,0,SIDE,SIDE,ceiling?'#16242e':'#163140');
    const step=ceiling?96:64;
    for(let y=0;y<SIDE;y+=step) for(let x=0;x<SIDE;x+=step) {
      const v=Math.floor(random()*8);
      rect(g,x+1,y+1,step-2,step-2,ceiling?
        'rgb('+ (23+v)+','+(34+v)+','+(44+v)+')':
        'rgb('+(15+v)+','+(33+v)+','+(46+v)+')');
      if(ceiling) {
        for(let k=5;k<step;k+=7) line(g,x+3,y+k,x+step-3,y+k,'#101f2b',2);
        line(g,x,y+step-2,x+step,y+step-2,'#59707b',2);
        line(g,x+step-3,y,x+step-3,y+step,'#344953',3);
      } else {
        line(g,x+1,y+1,x+step-1,y+1,'rgba(0,212,255,.28)',1);
        line(g,x+1,y+1,x+1,y+step-1,'rgba(0,212,255,.23)',1);
      }
    }
    for(let side=0;side<4;side++) {
      g.save(); g.translate(mid,mid); g.rotate(side*Math.PI/2);
      if(ceiling) {
        for(const x of [-486,-214,214,486]) {
          rect(g,x-6,-mid,12,453,'#08111b'); rect(g,x-6,-mid,2,453,'#8097a4');
          for(let y=-mid+19;y< -330;y+=87) {
            glow(g,x,y+32,21,63,'rgba(99,221,255,.3)');
            rect(g,x-1.7,y,3.4,64,'#dafaff');
          }
        }
        // Tapered edges on overlapping structural beams.
        for(const y of [-575,-323]) {
          rect(g,-mid,y,SIDE,13,'#09141e'); rect(g,-mid,y,SIDE,3,'#8496a0');
          rect(g,-mid,y+3,SIDE,6,'#354953');
        }
      } else {
        glow(g,0,-mid+150,420,365,'rgba(52,152,180,.40)');
        glow(g,130,-mid+180,115,275,'rgba(55,207,192,.20)');
        // Narrow anisotropic scratches break up the reflected LED light.
        for(let i=0;i<390;i++){
          const y=-mid+random()*470, x=(random()-.5)*800;
          rect(g,x,y,2+random()*18,.65,'rgba(178,233,240,'+random()*.11+')');
        }
        for (const x of [-278,278]) {
          rect(g,x-3,-mid,6,375,'#0f1d28');
          rect(g,x,-mid,1.6,375,blue);
          for(let y=-mid+26;y<-385;y+=60) rect(g,x+5,y,7,1.5,'#7cc6d2');
        }
      }
      g.restore();
    }
    if(ceiling) {
      const dome=g.createRadialGradient(mid,mid,18,mid,mid,322);
      dome.addColorStop(0,'#030c16'); dome.addColorStop(.75,'#122c40'); dome.addColorStop(1,'#283b4b');
      g.beginPath();g.arc(mid,mid,323,0,tau);g.fillStyle=dome;g.fill();
      for(let i=0;i<32;i++) {
        const a=i*tau/32; line(g,mid+Math.cos(a)*69,mid+Math.sin(a)*69,
          mid+Math.cos(a)*322,mid+Math.sin(a)*322,'#304451',2);
      }
      for(const r of [69,128,218,309,323]) {
        g.beginPath();g.arc(mid,mid,r,0,tau);g.strokeStyle=r===309?'#b1eaf0':'#59717e';g.lineWidth=r===309?3:2;g.stroke();
      }
    } else {
      for(let i=0;i<23000;i++) rect(g,random()*SIDE,random()*SIDE,1,1,'rgba(190,230,235,.06)');
      for(const r of [110,116]) {
        g.beginPath();g.arc(mid,mid,r,0,tau);g.strokeStyle='#407a88';g.lineWidth=1.5;g.stroke();
      }
    }
    return g.getImageData(0,0,SIDE,SIDE);
  }

  const wallPixels=directions.map((_,s)=>new Uint32Array(wallTexture(s).data.buffer));
  const floorPixels=new Uint32Array(horizontalTexture(false).data.buffer);
  const roofPixels=new Uint32Array(horizontalTexture(true).data.buffer);
  const raster=view.createImageData(W,H), out=new Uint32Array(raster.data.buffer);
  const sin=new Float64Array(W), cos=new Float64Array(W), distance=new Float64Array(W);
  const wallColumn=new Uint16Array(W), sideFor=new Uint8Array(W);
  for(let x=0;x<W;x++) {
    const angle=(x+.5-W/2)*tau/W;
    sin[x]=Math.sin(angle); cos[x]=Math.cos(angle);
    const side=Math.round(angle/(Math.PI/2));
    sideFor[x]=(side+4)%4;
    wallColumn[x]=Math.min(WALL-1,Math.floor((Math.tan(angle-side*Math.PI/2)+1)*WALL/2));
    distance[x]=radius/Math.max(Math.abs(sin[x]),Math.abs(cos[x]));
  }
  for(let y=0;y<H;y++) {
    const slope=Math.tan((.5-(y+.5)/H)*Math.PI);
    const surface=slope>0?roofPixels:floorPixels;
    const range=(slope>0?roof:floor)/slope;
    const planarScale=range*SIDE/(2*radius);
    for(let x=0;x<W;x++) {
      if(range<distance[x]){
        const u=(SIDE/2+sin[x]*planarScale)|0, v=(SIDE/2-cos[x]*planarScale)|0;
        out[y*W+x]=surface[v*SIDE+u];
      }else{
        const v=Math.min(WALL_H-1,Math.max(0,((roof-distance[x]*slope)*WALL_H/(roof-floor))|0));
        out[y*W+x]=wallPixels[sideFor[x]][v*WALL+wallColumn[x]];
      }
    }
  }
  view.putImageData(raster,0,0);

  // Project freestanding structures after the enclosing shell. Straight edges
  // are subdivided because lines become curves in an equirectangular texture.
  const shapes=[];
  let side=0;
  function world(x,y,z) {
    switch(side) {
      case 1:return [z,y,-x]; case 2:return [-x,y,-z]; case 3:return [-z,y,x];
      default:return [x,y,z];
    }
  }
  function face(points,color,stroke=0) {
    const verts=points.map(p=>world(...p));
    const center=verts.reduce((q,p)=>q.map((n,i)=>n+p[i]/verts.length),[0,0,0]);
    shapes.push({verts,color,stroke,depth:Math.hypot(...center)});
  }
  function box(x,y,z,w,h,d,front,top,edge) {
    const a=x-w/2,b=x+w/2,c=z-d/2,e=z+d/2,t=y+h;
    face([[a,y,c],[b,y,c],[b,t,c],[a,t,c]],front);
    face([[a,t,c],[b,t,c],[b,t,e],[a,t,e]],top);
    const k=x>0?a:b; face([[k,y,c],[k,y,e],[k,t,e],[k,t,c]],edge);
    if(y>0) face([[a,y,c],[b,y,c],[b,y,e],[a,y,e]],edge);
  }
  for(side=0;side<4;side++){
    for(const sign of [-1,1]){
      const x=sign*10.1, z=15;
      // Walk-in exhibition pods, layered bases, rear LED frames, suspended
      // fascias and vertical struts. Fine highlights keep silhouettes readable.
      box(x,floor,z,5.2,.19,4.4,'#223440','#576e78','#344d57');
      box(x,floor+.19,z,5.08,.035,4.26,'#73c2cd','#6d9fa7','#63b6c5');
      box(x,floor+.225,z,4.98,.08,4.15,'#283f4d','#334e5c','#233844');
      for(const k of [-1,1]) {
        box(x+2.24*k,floor+.30,z+1.4,.16,4.1,.17,'#354b58','#738390','#142936');
        box(x+2.24*k,floor+.39,z+1.30,.038,3.86,.02,blue,blue,blue);
      }
      box(x,1.5,z,5.1,.40,3.6,'#253945','#81939b','#122532');
      box(x,1.51,z-.01,4.91,.039,3.61,'#adf1f4','#98d6da','#77acb5');
      box(x,floor+.30,z-.14,2.5,.76,1.5,'#263e4a','#667f88','#142b36');
      box(x,floor+1.02,z-.14,2.6,.055,1.58,'#a6e8ec','#79b9c1','#52869a');
      const objY=floor+1.60;
      if(index===2) {
        box(x,objY-.50,z,1.78,1.05,.09,'#6192bd','#c2efff','#182937');
        for(let n=0;n<15;n++){
          const t=n/14;
          face([[x-.86,objY-.46+t*.7,z-.051],[x-.2,objY-.42+t*.54,z-.051],
            [x+.85,objY-.14+t*.65,z-.051]],n%3===0?accent:'#7ccacc',1.1);
        }
      } else {
        // A tilted luminous wire sculpture on each demonstration plinth.
        for(let n=0;n<14;n++){
          const ring=[];
          for(let k=0;k<=36;k++){
            const a=k*tau/36,b=n*Math.PI/14;
            const xx=.57*Math.cos(a), yy=.59*Math.sin(a)*Math.cos(b);
            ring.push([x+xx*.91-yy*.41,objY+xx*.41+yy*.91,z+.55*Math.sin(a)*Math.sin(b)]);
          }
          face(ring,n%4===0?accent:'#59abb8',1.05);
        }
      }
    }
    // Nearer ceiling gantries and paired spot fixtures.
    for(const z of [10.7,16.8]){
      const span=z*1.86;
      box(0,6.48,z,span,.13,.16,'#485965','#73828c','#14232e');
      box(0,7.14,z,span,.19,.24,'#697982','#899aa4','#1e303b');
      for(let x=-span/2+.05;x<span/2-.95;x+=1.12){
        face([[x,6.56,z],[x+.54,7.14,z],[x+1.08,6.56,z]],
          '#526572',3);
      }
      for(let x=-span/2+1.2;x<span/2;x+=3){
        box(x,6.25,z,.35,.19,.35,'#12242e','#4b606b','#253944');
        box(x,6.21,z,.27,.045,.27,'#cbf0fa','#e8fdff','#bae2e9');
      }
    }
  }
  function point(p) {
    return [W*(.5+Math.atan2(p[0],p[2])/tau),
      H*(.5-Math.atan2(p[1],Math.hypot(p[0],p[2]))/Math.PI)];
  }
  shapes.sort((a,b)=>b.depth-a.depth);
  for(const {verts,color,stroke} of shapes){
    const coords=[point(verts[0])];
    const segments=stroke?verts.length-1:verts.length;
    for(let i=0;i<segments;i++) {
      const a=verts[i],b=verts[(i+1)%verts.length];
      const steps=Math.max(1,Math.ceil(Math.hypot(...b.map((v,k)=>v-a[k]))/.65));
      for(let n=1;n<=steps;n++) {
        const q=point(a.map((v,k)=>v+(b[k]-v)*n/steps));
        const prev=coords[coords.length-1][0];
        q[0]+=Math.round((prev-q[0])/W)*W;
        coords.push(q);
      }
    }
    for(const shift of [-W,0,W]){
      if(coords.every(p=>p[0]+shift<0)||coords.every(p=>p[0]+shift>W)) continue;
      view.beginPath();view.moveTo(coords[0][0]+shift,coords[0][1]);
      for(let i=1;i<coords.length;i++) view.lineTo(coords[i][0]+shift,coords[i][1]);
      if(stroke){view.lineWidth=stroke;view.strokeStyle=color;view.stroke();}
      else {view.closePath();view.fillStyle=color;view.fill();}
    }
  }
  return result;
}

// Original vector studies for the hall directory. All dimensions are design pixels.
function drawHallThumbnail(canvas, index) {
  const ctx = canvas.getContext("2d");
  const accents = ["#bcf763", "#6be6e4", "#b4a2ff", "#ffbf76"];
  const shades = ["#142319", "#10262b", "#1c1c31", "#2b211c"];
  const color = accents[index];
  const shade = shades[index];
  canvas.width = 640;
  canvas.height = 200;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const glow = ctx.createRadialGradient(334, 99, 8, 334, 99, 315);
  glow.addColorStop(0, shade);
  glow.addColorStop(1, "#091117");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 640, 200);

  function stroke(points, opacity = 1, width = 1, fill = null) {
    ctx.beginPath();
    points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    if (fill) {
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.globalAlpha = opacity;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  function ring(x, y, rx, ry, opacity, width = 1, fill = null, tilt = 0) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, tilt, 0, Math.PI * 2);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.globalAlpha = opacity;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  for (let x = 0; x <= 640; x += 15) stroke([[x, 0], [x, 200]], x % 60 ? 0.035 : 0.075);
  for (let y = 0; y <= 200; y += 15) stroke([[0, y], [640, y]], y % 60 ? 0.035 : 0.075);
  for (const x of [46, 598]) {
    for (const y of [27, 171]) {
      stroke([[x - 4, y], [x + 4, y]], 0.33);
      stroke([[x, y - 4], [x, y + 4]], 0.33);
    }
  }
  function dimension(x1, x2, y) {
    stroke([[x1, y], [x2, y]], 0.3);
    for (const x of [x1, x2]) {
      stroke([[x - 3, y + 3], [x + 3, y - 3]], 0.5);
      stroke([[x, y + 6], [x, y - 9]], 0.28);
    }
  }

  if (index === 0) {
    const iso = (x, y, z) => [320 + x * 1.33 - y * 0.95, 144 + x * 0.18 + y * 0.31 - z];
    const line = (points, alpha = 0.84, width = 1, fill = null) =>
      stroke(points.map(p => iso(...p)), alpha, width, fill);
    const platform = (w, d, z, h) => {
      line([[-w,d,z],[w,d,z],[w,d,z+h],[-w,d,z+h]], 0.7, 1.2, shade);
      line([[w,d,z],[w,-d,z],[w,-d,z+h],[w,d,z+h]], 0.8, 1, shade);
      line([[-w,-d,z+h],[w,-d,z+h],[w,d,z+h],[-w,d,z+h]], 0.85, 1.3, shade);
    };
    platform(111, 46, 0, 5);
    for (let x = -100; x < 108; x += 14) line([[x,-44,5],[x,45,5]], 0.2);
    for (let y = -34; y < 45; y += 12) line([[-110,y,5],[109,y,5]], 0.2);
    for (const x of [-104, -52, 0, 52, 104]) {
      line([[x,-43,5],[x,-43,79],[x+3,-43,79],[x+3,-43,5]], 0.7, 1, shade);
    }
    line([[-104,-42,14],[104,-42,14],[104,-42,72],[-104,-42,72]], 0.7, 1.1, shade);
    for (let x = -102; x < 103; x += 13) line([[x,-42,15],[x,-42,71]], 0.3);
    for (let z = 19; z <= 72; z += 8) line([[-102,-42,z],[102,-42,z]], 0.23);
    line([[-40,-40,28],[40,-40,28],[40,-40,64],[-40,-40,64]], 0.95, 1.5, shade);
    for (let i = 0; i < 4; i++) line([[-28+i*9,-39,33],[-10+i*9,-39,58]], 0.66, 1.8);
    platform(46, 21, 6, 3);
    platform(40, 17, 9, 3);
    platform(24, 12, 12, 5);
    for (const y of [-43, 42]) {
      for (const x of [-104, 104]) {
        line([[x,y,5],[x,y,78],[x+4,y,78],[x+4,y,5]], 0.95, 1.3, shade);
        for (let z = 10; z < 71; z += 8) line([[x,y,z],[x+4,y,z+5]], 0.48);
      }
      line([[-104,y,77],[107,y,77],[107,y,83],[-104,y,83]], 0.94, 1.1, shade);
      for (let x = -104; x < 99; x += 12) line([[x,y,78],[x+6,y,83],[x+12,y,78]], 0.8);
    }
    for (const x of [-104,-55,0,54,104]) {
      line([[x,-43,83],[x,42,83],[x,42,78],[x,-43,78]], 0.74, 1, shade);
      for (let y = -42; y < 40; y += 12) line([[x,y,79],[x,y+6,83],[x,y+12,79]], 0.5);
    }
    dimension(135, 501, 187);
  } else if (index === 1) {
    const cylinder = (x, y, w, h) => {
      stroke([[x-w,y-h],[x+w,y-h],[x+w,y],[x-w,y]], 0.85, 1.3, shade);
      ring(x,y,w,w*0.2,0.87,1.3,shade);
      ring(x,y-h,w,w*0.2,0.88,1.5,shade);
      for (let dx = -w + 5; dx < w; dx += 9) stroke([[x+dx,y-h+3],[x+dx,y]],0.34);
    };
    function joint(x,y,r) {
      ring(x+5,y-2,r,r*0.94,0.85,1.4,shade);
      ring(x,y,r,r*0.94,0.98,1.6,shade);
      ring(x,y,r*0.72,r*0.69,0.55,1.2);
      ring(x,y,r*0.27,r*0.26,0.94,1.3,shade);
      for (let n = 0; n < 6; n++) {
        const a = n * Math.PI / 3;
        ring(x+Math.cos(a)*r*0.83,y+Math.sin(a)*r*0.79,1,1,0.7);
      }
    }
    function link(x1,y1,x2,y2,r1,r2) {
      const d = Math.hypot(x2-x1,y2-y1);
      const nx = -(y2-y1)/d, ny = (x2-x1)/d;
      const p = (u,v) => [x1+(x2-x1)*u+nx*v,y1+(y2-y1)*u+ny*v];
      stroke([p(0,r1),p(1,r2),p(1,-r2),p(0,-r1)],0.9,1.7,shade);
      stroke([p(0.14,r1-4),p(0.82,r2-4),p(0.93,0),p(0.84,-r2+4),p(0.16,-r1+4),p(0.1,0),p(0.14,r1-4)],0.66,1.1);
      stroke([p(0.17,0),p(0.81,0)],0.33);
      for (let i=0;i<6;i++) stroke([p(0.24+i*0.08,-3),p(0.27+i*0.08,3)],0.6);
    }
    cylinder(243,171,47,7);
    cylinder(243,161,34,13);
    stroke([[218,148],[223,124],[244,116],[260,124],[268,148]],0.87,1.6,shade);
    link(244,130,289,47,17,15);
    link(289,47,394,89,13,10);
    stroke([[236,115],[272,49],[278,37],[291,31],[309,36],[390,69],[400,78]],0.83,2);
    stroke([[240,113],[278,48],[283,40],[293,37],[310,42],[382,71]],0.65,1.25);
    joint(244,129,19);
    joint(289,47,18);
    link(395,88,426,69,9,7);
    joint(395,88,13);
    joint(426,69,9);
    link(428,69,449,79,6,5);
    stroke([[446,72],[456,72],[472,83],[475,94],[468,88],[452,80]],0.94,1.45,shade);
    stroke([[443,81],[450,88],[461,99],[470,101],[466,95],[455,82]],0.94,1.45,shade);
    dimension(192, 474, 186);
  } else if (index === 2) {
    stroke([[299,152],[322,148],[327,164],[362,171],[362,175],[297,184],[262,175],[262,171],[298,165]],0.83,1.4,shade);
    stroke([[263,171],[298,180],[361,171]],0.66);
    stroke([[305,142],[322,140],[324,164],[307,168]],0.74,1,shade);
    const screen = (u,v) => [196 + u*254, 52-u*34+v*113];
    stroke([[196,52],[450,18],[455,20],[455,136],[197,172],[191,170],[191,55]],0.93,1.6,shade);
    stroke([[196,52],[450,18],[450,131],[196,166]],0.95,1.8,shade);
    const face = (points, opacity, width) => stroke(points.map(([u,v]) => screen(u,v)),opacity,width);
    face([[0.018,0.035],[0.982,0.035],[0.982,0.961],[0.018,0.961],[0.018,0.035]],0.64,1.2);
    for (let i=0;i<21;i++) {
      const v=i/20;
      const lines=[];
      for(let j=0;j<=64;j++) {
        const u=j/64;
        const height=0.53+0.19*Math.sin(u*5.8+v*1.8)+0.095*Math.sin(u*10-v*3)+(v-0.5)*0.34;
        lines.push([0.04+u*0.92,height]);
      }
      face(lines,0.48+0.3*(1-v),i%5 ? 0.8 : 1.3);
    }
    for(let i=1;i<15;i++) {
      const u=i/15;
      const points=[];
      for(let k=0;k<=20;k++) {
        const v=k/20;
        points.push([0.04+u*0.92,0.53+0.19*Math.sin(u*5.8+v*1.8)+0.095*Math.sin(u*10-v*3)+(v-0.5)*0.34]);
      }
      face(points,0.29,0.8);
    }
    dimension(191,451,190);
  } else {
    // Coachwork sections run from the nose to the tail in vehicle coordinates.
    const proj = ([x,y,z]) => [321+x*1.28-y*0.85,149+x*0.09+y*0.41-z];
    const seg = (p,a=0.8,w=1,f=null) => stroke(p.map(proj),a,w,f);
    const axles = [-69,73];
    function wheel(x,y) {
      const [cx,cy] = proj([x,y,19]);
      ring(cx,cy,19,22,0.91,1.8,shade,-0.19);
      ring(cx,cy,13.6,16.1,0.8,1.3,shade,-0.19);
      for(let j=0;j<10;j++){
        const a=j*Math.PI/5;
        stroke([[cx+Math.cos(a)*4,cy+Math.sin(a)*4],[cx+Math.cos(a+0.12)*12,cy+Math.sin(a+0.12)*14]],0.84);
      }
      ring(cx,cy,3.5,4,0.94,1.4,shade);
    }
    axles.forEach(x=>wheel(x,-29));
    // x, half width, sill, shoulder, glass belt width, roof height, roof half width
    const stations = [
      [-116,18,13,21,13,23,9],[-108,27,10,29,19,31,13],[-91,34,12,35,24,38,17],
      [-67,35,13,39,26,42,18],[-47,34,14,40,26,46,22],[-22,33,14,43,28,66,20],
      [-7,33,14,44,28,72,20],[29,33,14,46,28,73,19],[52,34,14,44,26,66,20],
      [75,35,14,43,25,52,19],[96,33,14,42,24,43,16],[109,25,16,36,18,36,12]
    ];
    const section = ([x,w,base,shoulder,belt,roof,top]) => [
      [x,-w,base],[x,-w,shoulder],[x,-belt,shoulder+2],[x,-top,roof],
      [x,top,roof],[x,belt,shoulder+2],[x,w,shoulder],[x,w,base]
    ];
    const slices=stations.map(section);
    for(let n=0;n<slices.length-1;n++) {
      for(let k=1;k<7;k++) {
        const glass=(n>=4 && n<=8 && (k===2 || k===4));
        seg([slices[n][k],slices[n+1][k],slices[n+1][k+1],slices[n][k+1]],
          glass ? 0.66 : 0.43,0.9,glass ? "#121c22" : shade);
      }
    }
    for (const k of [3,4,5,6,7]) seg(slices.map(s=>s[k]),0.85,k===6 ? 1.7 : 1.1);
    seg([slices[0][0],slices[0][1],slices[0][2],slices[0][3],slices[0][4],slices[0][5],slices[0][6],slices[0][7]],0.94,1.4,shade);
    seg([[-115,-14,17],[-115,13,17],[-114,12,14],[-114,-12,14]],0.88,1.1);
    for(const y of [-1,1]) seg([[-111,15*y,23],[-108,22*y,26],[-97,28*y,30]],0.95,2);
    seg([[-40,34,38],[-31,34,21],[28,34,20],[38,34,43]],0.73,1.3);
    seg([[23,34,39],[29,34,39]],0.98,1.6);
    seg([[-46,29,43],[-38,37,47],[-42,41,48],[-48,36,47]],0.9,1,shade);
    axles.forEach(x=>wheel(x,35));
    for(const x of axles) {
      const p=[];
      for(let i=0;i<=24;i++) {
        const a=Math.PI*i/24;
        p.push([x+Math.cos(a)*20,35.5,17+Math.sin(a)*24]);
      }
      seg(p,0.8,1.25);
    }
    dimension(160,466,187);
  }
}

