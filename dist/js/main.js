import { Engine } from "./engine.js";
import { encodeWav, renderBinaural } from "./exporter.js";
import { AMBIENCES, DEFAULT_SETTINGS, EXPERIENCES, findRoom, MODES, ORBIT_BARS, RATES, ROOMS, STEM_NAMES, VOICES } from "./presets.js";
import { lineIndexAt, parseLrc, savedLrc, saveLrc } from "./lyrics.js";
import { classifyStyle, findStyle, STYLES, trackFeatures } from "./style.js";
import { HeadTracker } from "./tracking.js";
import { clamp, DEG, formatTime, mod, spherical } from "./util.js";
import { drawSpectrum, MIDS, StageView } from "./visual.js";

const STORAGE_KEY = "nearfield:settings:v2";

function stemSet(folder) {
  return Object.fromEntries(STEM_NAMES.map((stem) => [stem, `assets/stems/${folder}/${stem}.mp3`]));
}

const TRACKS = [
  { title: "Poker Face", artist: "Lady Gaga", album: "The Fame Monster", duration: 237.27, stems: stemSet("poker-face"), cover: "assets/covers/poker-face.jpg" },
  { title: "Love Me Not", artist: "Ravyn Lenae", album: "Love Me Not / Love Is Blind", duration: 213.525, stems: stemSet("love-me-not"), cover: "assets/covers/love-me-not.jpg" },
];

const $ = (selector) => document.querySelector(selector);
const els = {
  audioGate: $("#audioGate"), cover: $("#cover"), currentTime: $("#currentTime"), duration: $("#duration"),
  dialog: $("#infoDialog"), engineStatus: $("#engineStatus"), fileInput: $("#fileInput"),
  headphoneToggle: $("#headphoneToggle"), spatialToggle: $("#spatialToggle"),
  nextButton: $("#nextButton"), playButton: $("#playButton"), prevButton: $("#prevButton"), seek: $("#seek"),
  spectrumCanvas: $("#spectrumCanvas"), stageCanvas: $("#stageCanvas"), trackArtist: $("#trackArtist"),
  trackList: $("#trackList"), trackTitle: $("#trackTitle"), bpmValue: $("#bpmValue"),
  modeBadge: $("#modeBadge"), roomBadge: $("#roomBadge"), rateBadge: $("#rateBadge"),
  modeChips: $("#modeChips"), orbitRow: $("#orbitRow"), orbitChips: $("#orbitChips"), roomChips: $("#roomChips"),
  rateChips: $("#rateChips"), ambienceChips: $("#ambienceChips"), experienceGrid: $("#experienceGrid"),
  modeHint: $("#modeHint"), roomHint: $("#roomHint"), ambienceLevelBlock: $("#ambienceLevelBlock"),
  cameraButton: $("#cameraButton"), cameraState: $("#cameraState"), gyroButton: $("#gyroButton"), gyroState: $("#gyroState"),
  recenterButton: $("#recenterButton"), recenterRow: $("#recenterRow"), invertButton: $("#invertButton"), cameraPreview: $("#cameraPreview"), sceneInstruction: $("#sceneInstruction"),
  exportButton: $("#exportButton"), exportFill: $("#exportFill"), exportLabel: $("#exportLabel"),
  immersive: $("#immersive"), immersiveCanvas: $("#immersiveCanvas"), immersiveTitle: $("#immersiveTitle"),
  immersiveMode: $("#immersiveMode"), immersiveHint: $("#immersiveHint"), immersivePlay: $("#immersivePlay"),
  immersiveLyric: $("#immersiveLyric"), controlPanel: $(".control-panel"),
  styleChips: $("#styleChips"), styleInfo: $("#styleInfo"), slowedButton: $("#slowedButton"), reverbButton: $("#reverbButton"),
  lyricsStatus: $("#lyricsStatus"), lyricsLines: $("#lyricsLines"), lyricPrev: $("#lyricPrev"), lyricCurrent: $("#lyricCurrent"),
  lyricNext: $("#lyricNext"), karaokeButton: $("#karaokeButton"), lrcInput: $("#lrcInput"),
};

/* ───── settings ───── */

function loadSettings() {
  const settings = structuredClone(DEFAULT_SETTINGS);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && typeof saved === "object") {
      Object.keys(settings).forEach((key) => { if (key in saved && key !== "custom") settings[key] = saved[key]; });
      if (saved.custom) STEM_NAMES.forEach((stem) => { if (saved.custom[stem]) settings.custom[stem] = { ...settings.custom[stem], ...saved.custom[stem] }; });
    }
  } catch { /* storage unavailable */ }
  return settings;
}

let saveTimer = 0;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
  }, 250);
}

const settings = loadSettings();
const statuses = new Map();
const app = { trackIndex: 0, dragging: null, lastX: 0, lastY: 0, exporting: false, immersive: false, detected: null };
const lyrics = { lines: [], index: -2, track: null, wordsKey: "" };

const engine = new Engine(settings, {
  status: (text, busy = false, channel = "main") => setStatus(text, busy, channel),
  changed: () => updatePlaybackUI(),
  analyzed: (track) => onTrackAnalyzed(track),
});
const tracker = new HeadTracker((yaw, pitch) => { engine.head.yaw = yaw; engine.head.pitch = pitch; });
tracker.invert = settings.trackInvert;
const stage = new StageView(els.stageCanvas);
const immersiveStage = new StageView(els.immersiveCanvas, { immersive: true });

function setStatus(text, busy = false, channel = "main") {
  if (text) statuses.set(channel, { text, busy }); else statuses.delete(channel);
  updatePlaybackUI();
}

// Touching any of these by hand means "my own scene": the experience highlight and auto-style switch off.
const SCENE_KEYS = ["mode", "orbitBars", "room", "width", "distance", "motion", "roomAmt", "cue", "bass"];

// Single entry point for every settings change: UI, engine and storage stay in sync.
function applySettings(patch, { transition = false, fromExperience = false, fromStyle = false } = {}) {
  const previous = structuredClone(settings);
  Object.assign(settings, patch);
  if (!fromExperience && !fromStyle && SCENE_KEYS.some((key) => key in patch)) { settings.experience = null; settings.autoStyle = false; settings.style = null; }
  if (transition || (patch.mode && patch.mode !== previous.mode)) engine.transitionFrom(previous, transition ? 2 : 1.4);
  if ("rate" in patch) engine.setRate(settings.rate);
  if (["spatial", "headphone", "bass", "fxReverb", "fxAmount"].some((key) => key in patch)) engine.applyMix();
  if ("room" in patch || "distance" in patch) scheduleRoom();
  if ("ambience" in patch || "ambienceLevel" in patch) engine.applyAmbience();
  saveSettings();
  renderSettings();
}

let roomTimer = 0;
function scheduleRoom() {
  clearTimeout(roomTimer);
  roomTimer = setTimeout(() => engine.applyRoom(), 220);
}

/* ───── controls ───── */

const sliders = {
  width: { toValue: (v) => v / 100, fromValue: (s) => Math.round(s * 100), label: (s) => `${Math.round(s * 100)}%` },
  distance: { toValue: (v) => +(0.6 * 20 ** (v / 100)).toFixed(2), fromValue: (s) => Math.round(Math.log(s / 0.6) / Math.log(20) * 100), label: (s) => `${s < 10 ? s.toFixed(1) : Math.round(s)} м` },
  motion: { toValue: (v) => v / 100, fromValue: (s) => Math.round(s * 100), label: (s) => `${Math.round(s * 100)}%` },
  roomAmt: { toValue: (v) => v / 100, fromValue: (s) => Math.round(s * 100), label: (s) => `${Math.round(s * 100)}%` },
  cue: { toValue: (v) => v / 100, fromValue: (s) => Math.round(s * 100), label: (s) => `${Math.round(s * 100)}%` },
  bass: { toValue: (v) => v / 2, fromValue: (s) => Math.round(s * 2), label: (s) => `+${s.toFixed(1)} dB` },
  ambienceLevel: { toValue: (v) => v / 100, fromValue: (s) => Math.round(s * 100), label: (s) => `${Math.round(s * 100)}%` },
  slowRate: { toValue: (v) => v / 100, fromValue: (s) => Math.round(s * 100), label: (s) => `${Math.round(s * 100)}% скорости` },
  fxAmount: { toValue: (v) => v / 100, fromValue: (s) => Math.round(s * 100), label: (s) => `${Math.round(s * 100)}%` },
};

function chips(container, items, key, { label = (item) => item.label, value = (item) => item.id, title = (item) => item.hint } = {}) {
  container.innerHTML = items.map((item) => `<button type="button" class="chip" data-value="${value(item)}" title="${title(item) || ""}">${label(item)}</button>`).join("");
  container.querySelectorAll(".chip").forEach((chip, i) => chip.addEventListener("click", () => {
    const next = value(items[i]);
    if (settings[key] !== next) applySettings({ [key]: next });
  }));
}

function buildControls() {
  chips(els.modeChips, MODES, "mode");
  chips(els.orbitChips, ORBIT_BARS.map((bars) => ({ id: bars, label: `${bars} ${bars === 2 || bars === 4 ? "такта" : "тактов"}` })), "orbitBars");
  chips(els.roomChips, ROOMS, "room");
  chips(els.rateChips, RATES, "rate", { value: (item) => item.value });
  chips(els.ambienceChips, AMBIENCES, "ambience");
  els.experienceGrid.innerHTML = EXPERIENCES.map((exp, i) => `
    <button type="button" class="experience" data-experience="${exp.id}">
      <span class="experience-index">${String(i + 1).padStart(2, "0")}</span>
      <b>${exp.title}</b><small>${exp.sub}</small>
    </button>`).join("");
  els.experienceGrid.querySelectorAll(".experience").forEach((button) => button.addEventListener("click", () => {
    const exp = EXPERIENCES.find((item) => item.id === button.dataset.experience);
    applySettings({ ambienceLevel: DEFAULT_SETTINGS.ambienceLevel, ...exp.settings, experience: exp.id, autoStyle: false, style: null }, { transition: true, fromExperience: true });
    if (!engine.playing) engine.play().catch(showAudioGate);
  }));
  Object.entries(sliders).forEach(([key, slider]) => {
    const input = $(`#${key}`);
    input.addEventListener("input", () => {
      const value = slider.toValue(Number(input.value));
      applySettings(key === "slowRate" && settings.rate < 1 ? { slowRate: value, rate: value } : { [key]: value });
    });
  });
  els.styleChips.innerHTML = [{ id: "auto", label: "Авто", hint: "определять стиль каждого трека" }, ...STYLES]
    .map((style) => `<button type="button" class="chip" data-value="${style.id}" title="${style.hint}">${style.label}</button>`).join("");
  els.styleChips.querySelectorAll(".chip").forEach((chip) => chip.addEventListener("click", () => chooseStyle(chip.dataset.value)));
  els.slowedButton.addEventListener("click", () => applySettings({ rate: settings.rate < 1 ? 1 : settings.slowRate }));
  els.reverbButton.addEventListener("click", () => applySettings({ fxReverb: !settings.fxReverb }));
  document.querySelectorAll("[data-ui]").forEach((button) => button.addEventListener("click", () => applySettings({ uiMode: button.dataset.ui })));
}

/* ───── style ───── */

function chooseStyle(id) {
  if (id === "auto") {
    applySettings({ autoStyle: true, experience: null }, { fromStyle: true });
    if (app.detected) applyStyle(app.detected.id);
    return;
  }
  applySettings({ autoStyle: false, experience: null });
  applyStyle(id);
}

function applyStyle(id) {
  const style = findStyle(id);
  applySettings({ ...style.settings, style: id, experience: null }, { transition: true, fromStyle: true });
}

function onTrackAnalyzed(track) {
  if (track !== TRACKS[app.trackIndex]) return;
  try {
    const features = trackFeatures(engine.buffers, engine.analysis);
    app.detected = { ...classifyStyle(features), features };
  } catch (error) {
    console.warn("style detection failed", error);
    app.detected = null;
  }
  if (app.detected && settings.autoStyle && !settings.experience) applyStyle(app.detected.id);
  renderSettings();
  loadLyrics(track);
}

/* ───── lyrics ───── */

function setLyricsStatus(text) { els.lyricsStatus.textContent = text; }

function showLines(lines, status) {
  lyrics.lines = lines; lyrics.index = -2; lyrics.wordsKey = "";
  els.lyricsLines.classList.toggle("empty", !lines.length);
  setLyricsStatus(status);
}

function loadLyrics(track) {
  lyrics.track = track;
  const lrc = savedLrc(track);
  if (lrc) showLines(parseLrc(lrc), "Текст из твоего .lrc-файла");
  else if (!app.detected?.vocals) showLines([], "Инструментал: в треке не слышно вокала, текста нет.");
  else showLines([], "Текста для этого трека нет. Можно загрузить свой .lrc.");
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function updateLyrics(time) {
  const lines = lyrics.lines;
  if (!lines.length) { if (els.immersiveLyric.textContent) els.immersiveLyric.textContent = ""; return; }
  let index = lineIndexAt(lines, time);
  if (index >= 0 && time > lines[index].end + 1.5 && lines[index + 1]?.time > time + 1) index = -1;
  const current = lines[index];
  if (index !== lyrics.index) {
    lyrics.index = index;
    els.lyricPrev.textContent = lines[index - 1]?.text ?? "";
    els.lyricNext.textContent = lines[index + 1]?.text ?? (index < 0 ? lines[0].text : "");
    if (current?.words?.length) {
      els.lyricCurrent.innerHTML = current.words.map((word, i) => `<span class="w" data-i="${i}">${escapeHtml(word.word)}</span>`).join("");
    } else els.lyricCurrent.textContent = current?.text ?? "♪";
    els.immersiveLyric.textContent = current?.text ?? "";
  }
  if (current?.words?.length) {
    els.lyricCurrent.querySelectorAll(".w").forEach((span, i) => {
      const word = current.words[i];
      span.classList.toggle("sung", time >= word.end);
      span.classList.toggle("now", time >= word.start && time < word.end);
    });
  }
}

function setActive(container, value) {
  container.querySelectorAll(".chip").forEach((chip) => {
    const active = chip.dataset.value === String(value);
    chip.classList.toggle("active", active); chip.setAttribute("aria-pressed", String(active));
  });
}

function updateRange(input) {
  const min = Number(input.min || 0); const max = Number(input.max || 100);
  input.style.setProperty("--fill", `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

function renderSettings() {
  const mode = MODES.find((item) => item.id === settings.mode) || MODES[0];
  const room = findRoom(settings.room);
  setActive(els.modeChips, settings.mode); setActive(els.orbitChips, settings.orbitBars); setActive(els.roomChips, settings.room);
  setActive(els.rateChips, settings.rate); setActive(els.ambienceChips, settings.ambience);
  els.orbitRow.hidden = !mode.orbit;
  els.modeHint.textContent = mode.hint; els.roomHint.textContent = room.hint;
  els.ambienceLevelBlock.classList.toggle("muted", settings.ambience === "none");
  Object.entries(sliders).forEach(([key, slider]) => {
    const input = $(`#${key}`);
    if (document.activeElement !== input) input.value = slider.fromValue(settings[key]);
    $(`#${key}Value`).value = slider.label(settings[key]);
    updateRange(input);
  });
  els.experienceGrid.querySelectorAll(".experience").forEach((button) => button.classList.toggle("active", button.dataset.experience === settings.experience));
  els.controlPanel.classList.toggle("simple", settings.uiMode !== "pro");
  document.querySelectorAll("[data-ui]").forEach((button) => button.classList.toggle("active", button.dataset.ui === (settings.uiMode === "pro" ? "pro" : "simple")));
  const styleChip = settings.autoStyle ? "auto" : settings.style;
  els.styleChips.querySelectorAll(".chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.value === styleChip);
    chip.classList.toggle("detected", Boolean(app.detected) && chip.dataset.value === app.detected.id && chip.dataset.value !== styleChip);
  });
  const detected = app.detected;
  els.styleInfo.textContent = detected
    ? `похоже на «${findStyle(detected.id).label}» · ${Math.round(detected.confidence * 100)}% · ${detected.vocals ? "есть вокал" : "без вокала"}`
    : "определяю…";
  const slowed = settings.rate < 1;
  els.slowedButton.classList.toggle("active", slowed); els.slowedButton.setAttribute("aria-pressed", String(slowed));
  els.slowedButton.querySelector("em").textContent = slowed ? `${Math.round(settings.rate * 100)}%` : "ВЫКЛ";
  els.reverbButton.classList.toggle("active", settings.fxReverb); els.reverbButton.setAttribute("aria-pressed", String(settings.fxReverb));
  els.reverbButton.querySelector("em").textContent = settings.fxReverb ? "ВКЛ" : "ВЫКЛ";
  els.spatialToggle.checked = settings.spatial; els.headphoneToggle.checked = settings.headphone;
  els.modeBadge.textContent = mode.label.toUpperCase(); els.roomBadge.textContent = room.label.toUpperCase();
  els.rateBadge.textContent = RATES.find((rate) => rate.value === settings.rate)?.label || `${settings.rate}×`;
  els.immersiveMode.textContent = `${mode.label} · ${room.label}`.toUpperCase();
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === settings.view));
  els.sceneInstruction.textContent = settings.view === "top"
    ? "ТЯНИ ТОЧКУ — ПЕРЕСТАВИТЬ СТЕМ · ФОН — ПОВЕРНУТЬ"
    : "ПОТЯНИ — ПОВЕРНУТЬ СЦЕНУ · ДВОЙНОЙ КЛИК — СБРОС";
}

/* ───── tracks ───── */

function renderTracks() {
  els.trackList.innerHTML = TRACKS.map((track, index) => `
    <div class="track-row ${index === app.trackIndex ? "active" : ""}" data-index="${index}" tabindex="0" role="button" aria-label="Включить ${track.title}">
      <span class="track-row-number">${String(index + 1).padStart(2, "0")}</span>
      <img class="track-thumb" src="${track.cover}" alt="" />
      <span class="track-main"><b>${track.title}</b><small>${track.artist}${track.stems ? " · AI 4 stems" : " · stereo fallback"}</small></span>
      <span class="track-album">${track.album}</span><span class="track-length">${formatTime(track.duration)}</span>
      <button class="row-play" type="button" aria-label="Воспроизвести ${track.title}"></button>
    </div>`).join("");
  els.trackList.querySelectorAll(".track-row").forEach((row) => {
    const activate = () => selectTrack(Number(row.dataset.index), true);
    row.addEventListener("click", activate);
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } });
  });
}

function selectTrack(index, autoplay = false) {
  const wasPlaying = engine.playing;
  app.trackIndex = (index + TRACKS.length) % TRACKS.length;
  const track = TRACKS[app.trackIndex];
  engine.loadTrack(track).catch((error) => setStatus(`ОШИБКА · ${error.message}`.toUpperCase()));
  els.cover.src = track.cover; els.cover.alt = `Обложка ${track.title}`;
  els.trackTitle.textContent = track.title; els.trackArtist.textContent = track.artist;
  els.immersiveTitle.textContent = `${track.artist} — ${track.title}`;
  els.duration.textContent = formatTime(track.duration); els.currentTime.textContent = "0:00";
  els.seek.value = 0; updateRange(els.seek);
  document.querySelectorAll(".stem-chip").forEach((chip) => {
    const available = Boolean(track.stems) || chip.dataset.stem === "other";
    chip.classList.toggle("active", available); chip.disabled = !available;
    chip.setAttribute("aria-pressed", String(available));
  });
  renderTracks();
  app.detected = null; lyrics.track = track;
  showLines([], "Жду анализ вокала…");
  els.karaokeButton.classList.remove("active");
  els.karaokeButton.disabled = !track.stems;
  renderSettings();
  if (autoplay || wasPlaying) engine.play().catch(showAudioGate);
}

function togglePlayback() { if (engine.playing) engine.pause(); else engine.play().catch(showAudioGate); }

function showAudioGate() {
  els.audioGate.dataset.mode = "audio";
  els.audioGate.querySelector("span").textContent = "Браузер приостановил аудио";
  els.audioGate.querySelector("button").textContent = "ПРОДОЛЖИТЬ";
  els.audioGate.hidden = false;
}

function showNotice(text) {
  els.audioGate.querySelector("span").textContent = text;
  els.audioGate.querySelector("button").textContent = "ЗАКРЫТЬ";
  els.audioGate.dataset.mode = "notice";
  els.audioGate.hidden = false;
}

function updatePlaybackUI() {
  els.playButton.classList.toggle("playing", engine.playing);
  els.playButton.setAttribute("aria-label", engine.playing ? "Пауза" : "Воспроизвести");
  els.immersivePlay.textContent = engine.playing ? "ПАУЗА" : "ИГРАТЬ";
  els.trackList.querySelector(".track-row.active")?.classList.toggle("playing-row", engine.playing);
  const bpm = engine.analysis ? `${Math.round(engine.analysis.bpm * engine.rate)} BPM` : "— BPM";
  els.bpmValue.textContent = bpm;
  const status = [...statuses.values()].pop();
  $(".engine-status").classList.toggle("busy", Boolean(status?.busy));
  els.engineStatus.textContent = status?.text || (engine.playing ? `HRTF · ${bpm}` : "ДВИЖОК ГОТОВ");
}

/* ───── head tracking ───── */

function updateTrackingUI() {
  els.cameraButton.classList.toggle("active", tracker.source === "camera");
  els.gyroButton.classList.toggle("active", tracker.source === "gyro");
  els.cameraState.textContent = tracker.source === "camera" ? "ВКЛ" : "ВЫКЛ";
  els.gyroState.textContent = tracker.source === "gyro" ? "ВКЛ" : "ВЫКЛ";
  els.recenterRow.hidden = !tracker.source;
  els.invertButton.classList.toggle("active", settings.trackInvert);
  els.cameraPreview.hidden = tracker.source !== "camera";
}

async function toggleCamera() {
  if (tracker.source === "camera") { tracker.stop(); updateTrackingUI(); return; }
  els.cameraState.textContent = "…";
  try {
    await tracker.startCamera(els.cameraPreview, (text) => setStatus(text, true, "tracking"));
    setStatus(null, false, "tracking");
  } catch (error) {
    tracker.stop();
    setStatus(null, false, "tracking");
    showNotice(`Трекинг камерой: ${error.message || error}`);
  }
  updateTrackingUI();
}

async function toggleGyro() {
  if (tracker.source === "gyro") { tracker.stop(); updateTrackingUI(); return; }
  try { await tracker.startGyro(); } catch (error) { showNotice(`Гироскоп: ${error.message || error}`); }
  updateTrackingUI();
}

/* ───── scene interaction ───── */

// Freezes whatever the current mode is doing into editable custom positions.
function customFromCurrent() {
  const custom = {};
  STEM_NAMES.forEach((stem) => {
    const p = engine.viz[VOICES.findIndex((voice) => voice.id === MIDS[stem])];
    const { az, el, d } = spherical(p);
    custom[stem] = { az: mod(az - settings.sceneYaw / DEG + 180, 360) - 180, el: clamp(el, -40, 60), r: clamp(d / settings.distance, 0.25, 6) };
  });
  return custom;
}

function pointer(event) {
  const rect = els.stageCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

els.stageCanvas.addEventListener("pointerdown", (event) => {
  const { x, y } = pointer(event);
  const stem = settings.view === "top" ? stage.hitStem(x, y) : null;
  if (stem) {
    if (settings.mode !== "custom") applySettings({ custom: customFromCurrent(), mode: "custom" });
    app.dragging = { type: "stem", stem };
  } else app.dragging = { type: "rotate" };
  app.lastX = event.clientX; app.lastY = event.clientY;
  els.stageCanvas.setPointerCapture(event.pointerId);
});

els.stageCanvas.addEventListener("pointermove", (event) => {
  if (!app.dragging) return;
  if (app.dragging.type === "stem") {
    const { x, y } = pointer(event);
    const polar = stage.pointToPolar(x, y);
    const current = settings.custom[app.dragging.stem];
    const custom = { ...settings.custom, [app.dragging.stem]: { ...current, az: mod(polar.az - settings.sceneYaw / DEG + 180, 360) - 180, r: clamp(polar.d / settings.distance, 0.25, 6) } };
    applySettings({ custom });
  } else {
    settings.sceneYaw += (event.clientX - app.lastX) * 0.012;
    if (settings.view === "3d") stage.camEl = clamp(stage.camEl + (event.clientY - app.lastY) * 0.25, 4, 80);
    saveSettings();
  }
  app.lastX = event.clientX; app.lastY = event.clientY;
});

["pointerup", "pointercancel"].forEach((type) => els.stageCanvas.addEventListener(type, () => { app.dragging = null; }));
els.stageCanvas.addEventListener("dblclick", () => { settings.sceneYaw = 0; stage.camEl = 26; saveSettings(); });

/* ───── immersive ───── */

function setImmersive(open) {
  app.immersive = open;
  els.immersive.hidden = !open;
  document.body.classList.toggle("immersed", open);
  if (open) {
    els.immersiveHint.classList.remove("faded");
    setTimeout(() => els.immersiveHint.classList.add("faded"), 3500);
    els.immersive.requestFullscreen?.().catch(() => {});
    navigator.wakeLock?.request("screen").then((lock) => { app.wakeLock = lock; }).catch(() => {});
    if (!engine.playing) engine.play().catch(showAudioGate);
  } else {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    app.wakeLock?.release().catch(() => {}); app.wakeLock = null;
  }
}

document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && app.immersive) setImmersive(false); });

/* ───── export ───── */

// Some systems drop non-Latin names in the download attribute (the file arrives as "download"
// without an extension), so file names are transliterated.
const TRANSLIT = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
function safeFileName(text) {
  const latin = [...text].map((char) => {
    const lower = char.toLowerCase(); const mapped = TRANSLIT[lower];
    if (mapped === undefined) return char;
    return char === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
  }).join("");
  return latin.replace(/[^\w .,()+-]+/g, "_").replace(/\s+/g, " ").trim();
}

async function exportTrack() {
  if (app.exporting) return;
  app.exporting = true;
  els.exportButton.classList.add("working");
  const progress = (value) => {
    els.exportFill.style.width = `${Math.round(value * 100)}%`;
    els.exportLabel.textContent = `РЕНДЕР 3D · ${Math.round(value * 100)}%`;
  };
  try {
    await engine.init();
    const ok = await engine.loading;
    if (!ok) throw new Error("трек не загружен");
    progress(0);
    const rendered = await renderBinaural(engine, { onProgress: progress });
    els.exportLabel.textContent = "УПАКОВКА WAV…";
    const blob = encodeWav(rendered);
    const track = TRACKS[app.trackIndex];
    const mode = MODES.find((item) => item.id === settings.mode)?.label || settings.mode;
    const name = `${safeFileName(`${track.artist} - ${track.title} (Nearfield ${mode}, ${findRoom(settings.room).label})`)}.wav`;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  } catch (error) {
    console.error(error);
    showNotice(`Экспорт: ${error.message || error}`);
  } finally {
    app.exporting = false;
    els.exportButton.classList.remove("working");
    els.exportFill.style.width = "0%";
    els.exportLabel.textContent = "СКАЧАТЬ 3D-ВЕРСИЮ · WAV";
  }
}

/* ───── render loop ───── */

function updateStemMeters() {
  document.querySelectorAll(".stem-chip").forEach((chip) => {
    chip.querySelector("em").style.width = `${Math.max(4, (engine.energies[chip.dataset.stem] || 0) * 100)}%`;
  });
}

function checkTrackEnd() {
  if (engine.playing && engine.duration && engine.currentTime >= engine.duration - 0.03) selectTrack(app.trackIndex + 1, true);
}

function frame() {
  const now = performance.now();
  engine.tick();
  drawSpectrum(els.spectrumCanvas, engine.graph?.analyser, now);
  const view = { viz: engine.viz, energies: engine.energies, enabled: engine.stemEnabled, kick: engine.kick, view: settings.view, editing: settings.mode === "custom", now };
  stage.draw(view);
  if (app.immersive) immersiveStage.draw(view);
  const duration = engine.duration || TRACKS[app.trackIndex].duration;
  const current = engine.currentTime;
  els.currentTime.textContent = formatTime(current); els.duration.textContent = formatTime(duration);
  if (!els.seek.matches(":active") && duration) { els.seek.value = Math.round(current / duration * 1000); updateRange(els.seek); }
  checkTrackEnd();
  updateStemMeters();
  updateLyrics(current);
  if (tracker.source === "camera") els.cameraState.textContent = tracker.faceVisible ? "ЛИЦО ✓" : "НЕТ ЛИЦА";
  requestAnimationFrame(frame);
}

// Animation frames stop in background tabs; this keeps motion scheduled and playlists advancing.
setInterval(() => { if (document.hidden) { engine.tick(); checkTrackEnd(); } }, 250);

/* ───── events ───── */

els.playButton.addEventListener("click", togglePlayback);
els.prevButton.addEventListener("click", () => selectTrack(app.trackIndex - 1, true));
els.nextButton.addEventListener("click", () => selectTrack(app.trackIndex + 1, true));
document.querySelectorAll(".stem-chip").forEach((chip) => chip.addEventListener("click", () => {
  const stem = chip.dataset.stem; const enabled = !chip.classList.contains("active");
  chip.classList.toggle("active", enabled); chip.setAttribute("aria-pressed", String(enabled)); engine.setStemEnabled(stem, enabled);
  if (stem === "vocals") els.karaokeButton.classList.toggle("active", !enabled);
}));
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => applySettings({ view: button.dataset.view })));
els.spatialToggle.addEventListener("change", () => applySettings({ spatial: els.spatialToggle.checked }));
els.headphoneToggle.addEventListener("change", () => applySettings({ headphone: els.headphoneToggle.checked }));
els.karaokeButton.addEventListener("click", () => {
  const chip = document.querySelector('.stem-chip[data-stem="vocals"]');
  if (!chip.disabled) chip.click();
});
els.lrcInput.addEventListener("change", async () => {
  const file = els.lrcInput.files?.[0]; if (!file) return;
  const text = await file.text();
  const lines = parseLrc(text);
  if (!lines.length) showNotice("В файле нет строк с таймкодами вида [мм:сс.xx]");
  else { const track = TRACKS[app.trackIndex]; saveLrc(track, text); lyrics.track = track; showLines(lines, `Текст из файла ${file.name}`); }
  els.lrcInput.value = "";
});
els.cameraButton.addEventListener("click", toggleCamera);
els.gyroButton.addEventListener("click", toggleGyro);
els.recenterButton.addEventListener("click", () => tracker.recenter());
els.invertButton.addEventListener("click", () => {
  settings.trackInvert = !settings.trackInvert; tracker.invert = settings.trackInvert;
  saveSettings(); updateTrackingUI();
});
els.exportButton.addEventListener("click", exportTrack);
$("#immersiveButton").addEventListener("click", () => setImmersive(true));
$("#immersiveButtonTop").addEventListener("click", () => setImmersive(true));
$("#immersiveExit").addEventListener("click", () => setImmersive(false));
els.immersivePlay.addEventListener("click", togglePlayback);
els.seek.addEventListener("input", () => {
  const duration = engine.duration || TRACKS[app.trackIndex].duration;
  engine.seek(Number(els.seek.value) / 1000 * duration); updateRange(els.seek);
});
els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files?.[0]; if (!file) return;
  const addLabel = document.querySelector(".add-track");
  const originalLabel = addLabel.lastChild.textContent;
  addLabel.classList.add("processing");
  addLabel.lastChild.textContent = " AI РАЗДЕЛЯЕТ…";
  setStatus("DEMUCS · ПОДГОТОВКА", true, "demucs");
  try {
    const form = new FormData(); form.append("file", file);
    const response = await fetch("/api/separate", { method: "POST", body: form });
    const started = await response.json();
    if (!response.ok) throw new Error(started.error || "Не удалось запустить AI-разбор");
    let result;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const statusResponse = await fetch(`/api/jobs/${started.jobId}`, { cache: "no-store" });
      result = await statusResponse.json();
      setStatus(result.state === "queued" ? "DEMUCS · В ОЧЕРЕДИ" : "DEMUCS · РАЗДЕЛЯЕТ", true, "demucs");
      if (result.state === "done" || result.state === "error") break;
    }
    if (result.state === "error") throw new Error(result.message);
    TRACKS.push({ ...result.track, cover: TRACKS[app.trackIndex].cover });
    selectTrack(TRACKS.length - 1, true);
  } catch (error) {
    showNotice(`AI-разбор: ${error.message}`);
  } finally {
    setStatus(null, false, "demucs");
    addLabel.classList.remove("processing");
    addLabel.lastChild.textContent = originalLabel;
    els.fileInput.value = "";
  }
});
$("#infoButton").addEventListener("click", () => els.dialog.showModal());
$("#dialogClose").addEventListener("click", () => els.dialog.close());
$("#dialogConfirm").addEventListener("click", () => els.dialog.close());
$("#resumeButton").addEventListener("click", async () => {
  if (els.audioGate.dataset.mode === "notice") { els.audioGate.hidden = true; return; }
  await engine.context?.resume(); els.audioGate.hidden = true; engine.play().catch(showAudioGate);
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && engine.context?.state === "suspended" && engine.playing) showAudioGate(); });

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  const typing = target instanceof HTMLInputElement && target.type !== "checkbox" && target.type !== "range";
  if (typing || els.dialog.open) return;
  const onControl = target instanceof HTMLButtonElement || target instanceof HTMLInputElement;
  switch (event.code) {
    case "Space":
      if (onControl && !app.immersive) return;
      event.preventDefault(); togglePlayback(); break;
    case "ArrowLeft": case "ArrowRight":
      if (target instanceof HTMLInputElement && target.type === "range") return;
      event.preventDefault(); engine.seek(engine.currentTime + (event.code === "ArrowLeft" ? -5 : 5)); break;
    case "KeyD": applySettings({ spatial: !settings.spatial }); break;
    case "KeyF": setImmersive(!app.immersive); break;
    case "KeyC": tracker.recenter(); break;
    case "Escape": if (app.immersive) setImmersive(false); break;
    default: break;
  }
});

/* ───── start ───── */

buildControls();
renderSettings();
selectTrack(0, false);
updateRange(els.seek);
updatePlaybackUI();
updateTrackingUI();
requestAnimationFrame(frame);

// Debug / automation handle.
window.nearfield = { engine, settings, applySettings, tracker, stage, renderBinaural, encodeWav, TRACKS, app, lyrics };
