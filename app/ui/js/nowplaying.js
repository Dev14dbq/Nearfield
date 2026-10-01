/* Full-screen player: cover + live 3D stage, synced lyrics, scene controls, queue, immersive mode. */

import { api } from "./api.js";
import { lineIndexAt, parseLrc } from "../engine/lyrics.js";
import { EXPERIENCES, findRoom, MODES, ROOMS } from "../engine/presets.js";
import { findStyle, STYLES } from "../engine/style.js";
import { StageView } from "../engine/visual.js";
import { findMood } from "./moods.js";
import { player } from "./player.js";
import { library, toggleFavorite } from "./tracks.js";
import { $, $$, artistNames, cover, esc, fmtTime, ICON } from "./ui.js";

const els = {
  np: $("#np"), bg: $("#npBg"), cover: $("#npCover"), title: $("#npTitle"), artist: $("#npArtist"), heart: $("#npHeart"),
  tags: $("#npTags"), context: $("#npContext"), lyrics: $("#lyrics"), scene: $("#scenePanel"), queue: $("#queuePanel"),
  immersive: $("#immersive"), immLyric: $("#immLyric"), immTitle: $("#immTitle"), immMode: $("#immMode"),
};
const stage = new StageView($("#stageCanvas"));
const immersiveStage = new StageView($("#immersiveCanvas"), { immersive: true });
const lyricsState = { lines: [], synced: false, index: -2, trackId: null };
let navigate = () => {};
let tab = "lyrics";
let simpleScene = true;

export const nowPlaying = {
  get open() { return !els.np.hidden; },
  get immersive() { return !els.immersive.hidden; },
  setNavigator(fn) { navigate = fn; },
  show() { els.np.hidden = false; requestAnimationFrame(() => els.np.classList.add("in")); renderAll(); },
  hide() { els.np.classList.remove("in"); setTimeout(() => { els.np.hidden = true; }, 260); },
  toggle() { if (this.open) this.hide(); else this.show(); },
  setImmersive(on) {
    els.immersive.hidden = !on;
    if (on) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  },
};

/* ───── header / meta ───── */

function renderMeta() {
  const track = player.track;
  if (!track) return;
  els.bg.src = track.cover || ""; els.cover.src = track.cover || "";
  els.cover.hidden = !track.cover;
  els.title.textContent = track.title;
  els.artist.textContent = artistNames(track);
  els.heart.classList.toggle("on", Boolean(library.get(track.id)?.favorite));
  els.context.textContent = player.context?.label || "";
  els.immTitle.textContent = `${artistNames(track)} — ${track.title}`;
  const item = player.current;
  const tags = [];
  if (item?.preview) tags.push(`<span class="tag warn">Превью 30 сек — войди в Яндекс Музыку</span>`);
  else if (item?.stems) tags.push(`<span class="tag ok">Полный 3D · 4 стема</span>`);
  else if (item) tags.push(`<span class="tag" title="Трек ещё не разделён на стемы: в избранном это сделается само">3D без стемов</span>`);
  if (player.detected) tags.push(`<span class="tag">Стиль: ${findStyle(player.detected.id).label}</span>`);
  if (player.engine.analysis) tags.push(`<span class="tag">${Math.round(player.engine.analysis.bpm * player.engine.rate)} BPM</span>`);
  if (track.album) tags.push(`<span class="tag">${esc(track.album)}${track.year ? ` · ${track.year}` : ""}</span>`);
  els.tags.innerHTML = tags.join("");
}

els.artist.addEventListener("click", () => {
  const id = player.track?.artists?.find((a) => a.id)?.id;
  if (id) { nowPlaying.hide(); navigate("artist", { id }); }
});
els.heart.addEventListener("click", async () => { if (player.track) { await toggleFavorite(player.track); renderMeta(); } });

/* ───── lyrics ───── */

async function loadLyrics() {
  const track = player.track;
  if (!track || lyricsState.trackId === track.id) return;
  lyricsState.trackId = track.id; lyricsState.lines = []; lyricsState.index = -2;
  els.lyrics.innerHTML = `<div class="lyrics-note">Ищу текст…</div>`;
  els.immLyric.textContent = "";
  const result = await api.lyrics(track).catch(() => null);
  if (lyricsState.trackId !== track.id) return;
  if (!result) {
    els.lyrics.innerHTML = `<div class="lyrics-note"><b>Текста нет</b><span>Ни площадка трека, ни открытая база LRCLIB его не знают.</span></div>`;
    return;
  }
  lyricsState.synced = result.synced;
  if (result.synced) {
    lyricsState.lines = parseLrc(result.text);
    els.lyrics.innerHTML = lyricsState.lines.map((line, i) => `<p data-i="${i}" data-t="${line.time}">${esc(line.text)}</p>`).join("") + `<div class="lyrics-src">Текст: ${esc(result.source)}</div>`;
    $$("p", els.lyrics).forEach((p) => p.addEventListener("click", () => player.engine.seek(Number(p.dataset.t))));
  } else {
    els.lyrics.innerHTML = `<div class="lyrics-plain">${esc(result.text).replace(/\n/g, "<br>")}</div><div class="lyrics-src">Текст: ${esc(result.source)} · без синхронизации</div>`;
  }
}

function updateLyrics(time) {
  const lines = lyricsState.lines;
  if (!lines.length) return;
  const index = lineIndexAt(lines, time + 0.25);
  if (index === lyricsState.index) return;
  lyricsState.index = index;
  els.immLyric.textContent = lines[index]?.text ?? "";
  if (els.np.hidden || tab !== "lyrics") return;
  $$("p", els.lyrics).forEach((p, i) => { p.classList.toggle("now", i === index); p.classList.toggle("past", i < index); });
  const active = els.lyrics.querySelector("p.now");
  if (active) els.lyrics.scrollTo({ top: active.offsetTop - els.lyrics.clientHeight * 0.38, behavior: "smooth" });
}

/* ───── scene ───── */

function chipRow(items, active, attr) {
  return items.map((item) => `<button class="chip ${String(item.value) === String(active) ? "active" : ""}" data-${attr}="${item.value}" title="${esc(item.hint || "")}">${esc(item.label)}</button>`).join("");
}

const SLIDERS = [
  { key: "distance", label: "Дистанция", min: 0, max: 100, to: (v) => +(0.6 * 20 ** (v / 100)).toFixed(2), from: (s) => Math.round(Math.log(s / 0.6) / Math.log(20) * 100), fmt: (s) => `${s < 10 ? s.toFixed(1) : Math.round(s)} м` },
  { key: "motion", label: "Движение", min: 0, max: 100, to: (v) => v / 100, from: (s) => Math.round(s * 100), fmt: (s) => `${Math.round(s * 100)}%` },
  { key: "roomAmt", label: "Комната", min: 0, max: 200, to: (v) => v / 100, from: (s) => Math.round(s * 100), fmt: (s) => `${Math.round(s * 100)}%` },
  { key: "bass", label: "Бас", min: 0, max: 16, to: (v) => v / 2, from: (s) => Math.round(s * 2), fmt: (s) => `+${s.toFixed(1)} dB` },
  { key: "width", label: "Ширина", min: 60, max: 160, to: (v) => v / 100, from: (s) => Math.round(s * 100), fmt: (s) => `${Math.round(s * 100)}%`, pro: true },
  { key: "cue", label: "3D-чёткость", min: 0, max: 100, to: (v) => v / 100, from: (s) => Math.round(s * 100), fmt: (s) => `${Math.round(s * 100)}%`, pro: true },
  { key: "slowRate", label: "Скорость Slowed", min: 70, max: 95, to: (v) => v / 100, from: (s) => Math.round(s * 100), fmt: (s) => `${Math.round(s * 100)}%`, pro: true },
  { key: "fxAmount", label: "Сила Reverb", min: 0, max: 100, to: (v) => v / 100, from: (s) => Math.round(s * 100), fmt: (s) => `${Math.round(s * 100)}%`, pro: true },
];

function renderScene() {
  const s = player.settings;
  const mood = player.mood;
  const detected = player.detected;
  const styleNote = mood
    ? `Сцену задаёт настроение «${mood.label}»`
    : detected ? `Похоже на «${findStyle(detected.id).label}» · ${Math.round(detected.confidence * 100)}%${detected.vocals ? " · есть вокал" : " · без вокала"}` : player.current?.stems ? "определяю стиль…" : "стиль определится после 3D-подготовки";
  els.scene.innerHTML = `
    <div class="scene-block">
      <div class="fx-row">
        <button class="fx ${s.spatial ? "on" : ""}" data-fx="spatial"><b>3D</b><small>${s.spatial ? "вкл" : "выкл"}</small></button>
        <button class="fx ${s.rate < 1 ? "on" : ""}" data-fx="slowed"><b>Slowed</b><small>${s.rate < 1 ? `${Math.round(s.rate * 100)}%` : "выкл"}</small></button>
        <button class="fx ${s.fxReverb ? "on" : ""}" data-fx="reverb"><b>Reverb</b><small>${s.fxReverb ? "вкл" : "выкл"}</small></button>
      </div>
    </div>
    <div class="scene-block">
      <div class="block-head"><b>Стиль</b><small>${styleNote}</small></div>
      <div class="chips">${chipRow([{ value: "auto", label: "Авто", hint: "свой стиль для каждого трека" }, ...STYLES.map((st) => ({ value: st.id, label: st.label, hint: st.hint }))], s.autoStyle ? "auto" : s.style, "style")}</div>
    </div>
    <div class="scene-block">
      <div class="block-head"><b>Сценарии</b><small>одно нажатие — целая сцена</small></div>
      <div class="exp-grid">${EXPERIENCES.map((exp) => `<button class="exp ${s.experience === exp.id ? "active" : ""}" data-exp="${exp.id}"><b>${esc(exp.title)}</b><small>${esc(exp.sub)}</small></button>`).join("")}</div>
    </div>
    <div class="scene-block">
      <div class="block-head"><b>Настройка</b><div class="seg"><button class="${simpleScene ? "active" : ""}" data-ui="simple">Просто</button><button class="${simpleScene ? "" : "active"}" data-ui="pro">Тонко</button></div></div>
      ${simpleScene ? "" : `<div class="sub-label">Движение</div><div class="chips">${chipRow(MODES.filter((m) => m.id !== "custom").map((m) => ({ value: m.id, label: m.label, hint: m.hint })), s.mode, "mode")}</div>`}
      <div class="sub-label">Комната</div><div class="chips">${chipRow(ROOMS.map((r) => ({ value: r.id, label: r.label, hint: r.hint })), s.room, "room")}</div>
      <div class="sliders">${SLIDERS.filter((sl) => !simpleScene || !sl.pro).map((sl) => `
        <label class="slider"><span>${sl.label}<output>${sl.fmt(s[sl.key])}</output></span><input type="range" min="${sl.min}" max="${sl.max}" value="${sl.from(s[sl.key])}" data-key="${sl.key}" /></label>`).join("")}</div>
    </div>`;
  $$("[data-fx]", els.scene).forEach((b) => b.addEventListener("click", () => {
    const fx = b.dataset.fx;
    if (fx === "spatial") player.toggleSpatial(); else if (fx === "slowed") player.toggleSlowed(); else player.toggleReverb();
  }));
  $$("[data-style]", els.scene).forEach((b) => b.addEventListener("click", () => { player.mood = null; player.chooseStyle(b.dataset.style); }));
  $$("[data-exp]", els.scene).forEach((b) => b.addEventListener("click", () => { player.mood = null; player.applyExperience(EXPERIENCES.find((e) => e.id === b.dataset.exp)); }));
  $$("[data-mode]", els.scene).forEach((b) => b.addEventListener("click", () => player.apply({ mode: b.dataset.mode })));
  $$("[data-room]", els.scene).forEach((b) => b.addEventListener("click", () => player.apply({ room: b.dataset.room })));
  $$("[data-ui]", els.scene).forEach((b) => b.addEventListener("click", () => { simpleScene = b.dataset.ui === "simple"; renderScene(); }));
  $$("input[type=range]", els.scene).forEach((input) => {
    const sl = SLIDERS.find((x) => x.key === input.dataset.key);
    paintRange(input);
    input.addEventListener("input", () => {
      const value = sl.to(Number(input.value));
      const patch = sl.key === "slowRate" && player.settings.rate < 1 ? { slowRate: value, rate: value } : { [sl.key]: value };
      player.apply(patch, { manual: !["slowRate", "fxAmount"].includes(sl.key) });
      input.previousElementSibling.querySelector("output").textContent = sl.fmt(player.settings[sl.key]);
      paintRange(input);
    });
  });
}

export function paintRange(input) {
  const min = Number(input.min || 0); const max = Number(input.max || 100);
  input.style.setProperty("--fill", `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

/* ───── queue ───── */

function renderQueue() {
  const rows = player.queue.map((t, i) => `
    <div class="qrow ${i === player.index ? "now" : i < player.index ? "past" : ""}" data-i="${i}">
      ${cover(t.cover, "xs")}<span><b>${esc(t.title)}</b><small>${esc(artistNames(t))}</small></span><em>${fmtTime(t.duration)}</em>
      ${i === player.index ? "" : `<button class="icon-btn small" data-rm="${i}" title="Убрать">${ICON.trash}</button>`}
    </div>`).join("");
  els.queue.innerHTML = `<div class="queue-head"><b>${esc(player.context?.label || "Очередь")}</b><small>${player.queue.length} треков</small></div>${rows || `<div class="empty-note">Очередь пуста</div>`}`;
  $$(".qrow", els.queue).forEach((row) => row.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) { e.stopPropagation(); player.removeFromQueue(Number(rm.dataset.rm)); return; }
    player.playAt(Number(row.dataset.i));
  }));
  els.queue.querySelector(".qrow.now")?.scrollIntoView({ block: "center" });
}

/* ───── tabs ───── */

function setTab(name) {
  tab = name;
  $$("#npTabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab-panel").forEach((p) => { p.hidden = p.dataset.panel !== name; });
  if (name === "scene") renderScene();
  if (name === "queue") renderQueue();
  if (name === "lyrics") { lyricsState.index = -2; updateLyrics(player.engine.currentTime); }
}
$$("#npTabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
export const openSceneTab = () => { nowPlaying.show(); setTab("scene"); };
export const openQueueTab = () => { nowPlaying.show(); setTab("queue"); };

function renderAll() {
  renderMeta();
  loadLyrics();
  if (tab === "scene") renderScene();
  if (tab === "queue") renderQueue();
}

player.on("track", () => { lyricsState.trackId = null; renderAll(); });
player.on("analyzed", () => { renderMeta(); if (tab === "scene" && nowPlaying.open) renderScene(); });
player.on("settings", () => {
  if (tab === "scene" && nowPlaying.open && !document.activeElement?.matches?.("#scenePanel input")) renderScene();
  const mode = MODES.find((m) => m.id === player.settings.mode);
  els.immMode.textContent = `${mode?.label || ""} · ${findRoom(player.settings.room).label}${player.mood ? ` · ${findMood(player.mood.id).label}` : ""}`;
});
player.on("queue", () => { if (tab === "queue" && nowPlaying.open) renderQueue(); });

$("#npClose").addEventListener("click", () => nowPlaying.hide());
$("#npImmersive").addEventListener("click", () => nowPlaying.setImmersive(true));
$("#immClose").addEventListener("click", () => nowPlaying.setImmersive(false));
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && nowPlaying.immersive) els.immersive.hidden = true; });

/* ───── per-frame ───── */

export function drawFrame(now) {
  const engine = player.engine;
  const time = engine.currentTime;
  updateLyrics(time);
  if (!nowPlaying.open && !nowPlaying.immersive) return;
  const frame = { viz: engine.viz, energies: engine.energies, enabled: engine.stemEnabled, kick: engine.kick, view: "3d", editing: false, now };
  if (nowPlaying.open) stage.draw(frame);
  if (nowPlaying.immersive) immersiveStage.draw(frame);
  const kick = engine.kick;
  els.cover.style.transform = `scale(${1 + kick * 0.018})`;
}
