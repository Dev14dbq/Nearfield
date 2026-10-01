/* Full-window player: cover + live 3D stage, controls, synced lyrics, this track's sound, queue. */

import { api } from "./api.js";
import { lineIndexAt, parseLrc } from "../engine/lyrics.js";
import { AMBIENCES, findRoom, MODES, ROOMS } from "../engine/presets.js";
import { StageView } from "../engine/visual.js";
import { player } from "./player.js";
import { ROOM_FIT, SCENE_PRESETS, SPEEDS, STYLE_SCENES } from "./scenes.js";
import { library, toggleFavorite } from "./tracks.js";
import { $, $$, artistNames, cover, esc, fmtTime, ICON } from "./ui.js";

const els = {
  np: $("#np"), bg: $("#npBg"), cover: $("#npCover"), title: $("#npTitle"), artist: $("#npArtist"), heart: $("#npHeart"),
  context: $("#npContext"), lyrics: $("#lyrics"), sound: $("#soundPanel"), queue: $("#queuePanel"),
  seek: $("#npSeek"), cur: $("#npCur"), dur: $("#npDur"), badge: $("#npBadge"), play: $("#npPlay"),
  shuffle: $("#npShuffle"), repeat: $("#npRepeat"), volume: $("#npVolume"),
  immersive: $("#immersive"), immLyric: $("#immLyric"), immMode: $("#immMode"),
};
const stage = new StageView($("#stageCanvas"));
const immersiveStage = new StageView($("#immersiveCanvas"), { immersive: true });
const lyricsState = { lines: [], index: -2, trackId: null };
let navigate = () => {};
let tab = "lyrics";
let fine = false;

export const nowPlaying = {
  get open() { return !els.np.hidden; },
  get immersive() { return !els.immersive.hidden; },
  setNavigator(fn) { navigate = fn; },
  show(withTab) {
    if (!player.track) return;
    els.np.hidden = false;
    document.body.classList.add("np-open");
    requestAnimationFrame(() => els.np.classList.add("in"));
    if (withTab) setTab(withTab); else renderAll();
  },
  hide() {
    if (els.np.hidden) return;
    els.np.classList.remove("in");
    document.body.classList.remove("np-open");
    setTimeout(() => { if (!els.np.classList.contains("in")) els.np.hidden = true; }, 240);
  },
  toggle() { if (this.open) this.hide(); else this.show(); },
  setImmersive(on) {
    els.immersive.hidden = !on;
    if (on) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  },
};

/* ───── meta + controls ───── */

const CONTEXT_LABEL = { favorites: "Избранное", playlist: "Плейлист", mood: "Настроение", artist: "Артист", album: "Альбом", search: "Поиск", history: "Недавнее" };

function renderMeta() {
  const track = player.track;
  if (!track) return;
  els.bg.src = track.cover || ""; els.cover.src = track.cover || "";
  els.cover.hidden = !track.cover;
  els.title.textContent = track.title;
  els.artist.textContent = artistNames(track);
  els.heart.classList.toggle("on", Boolean(library.get(track.id)?.favorite));
  const ctx = player.context;
  els.context.innerHTML = ctx ? `<small>${CONTEXT_LABEL[ctx.type] || "Играет"}</small><b>${esc(ctx.label.replace(/^(Настроение · |Поиск: )/, ""))}</b>` : "";
  const item = player.current;
  els.badge.textContent = item?.preview ? "превью 30 сек" : item && !item.stems ? "3D без стемов" : "";
  els.badge.title = item && !item.stems && !item.preview ? "Трек ещё не разделён на стемы — после этого 3D станет полным" : "";
}

function renderControls() {
  els.play.classList.toggle("playing", player.playing);
  els.play.classList.toggle("loading", Boolean(player.loadingTrack));
  els.shuffle.classList.toggle("on", player.shuffle);
  els.repeat.classList.toggle("on", player.repeat !== "off");
  els.repeat.classList.toggle("one", player.repeat === "one");
}

els.artist.addEventListener("click", () => {
  const id = player.track?.artists?.find((a) => a.id)?.id;
  if (id) { nowPlaying.hide(); navigate("artist", { id }); }
});
els.heart.addEventListener("click", async () => { if (player.track) { await toggleFavorite(player.track); renderMeta(); } });
els.play.addEventListener("click", () => player.toggle());
$("#npPrev").addEventListener("click", () => player.prev());
$("#npNext").addEventListener("click", () => player.next());
els.shuffle.addEventListener("click", () => player.setShuffle(!player.shuffle));
els.repeat.addEventListener("click", () => player.cycleRepeat());
els.seek.addEventListener("input", () => {
  const duration = player.engine.duration || player.track?.duration || 0;
  player.engine.seek(Number(els.seek.value) / 1000 * duration);
  paintRange(els.seek);
});
els.volume.addEventListener("input", () => { player.setVolume(Number(els.volume.value) / 100); paintRange(els.volume); document.dispatchEvent(new CustomEvent("volume-changed")); });
export function syncVolume() { els.volume.value = Math.round(player.volume * 100); paintRange(els.volume); }

/* ───── lyrics ───── */

async function loadLyrics() {
  const track = player.track;
  if (!track || lyricsState.trackId === track.id) return;
  lyricsState.trackId = track.id; lyricsState.lines = []; lyricsState.index = -2;
  els.lyrics.innerHTML = `<div class="lyrics-note">…</div>`;
  els.immLyric.textContent = "";
  const result = await api.lyrics(track).catch(() => null);
  if (lyricsState.trackId !== track.id) return;
  if (!result) { els.lyrics.innerHTML = `<div class="lyrics-note"><b>Текста нет</b></div>`; return; }
  if (result.synced) {
    lyricsState.lines = parseLrc(result.text);
    els.lyrics.innerHTML = lyricsState.lines.map((line, i) => `<p data-i="${i}" data-t="${line.time}">${esc(line.text) || "♪"}</p>`).join("") + `<div class="lyrics-src">${esc(result.source)}</div>`;
    $$("p", els.lyrics).forEach((p) => p.addEventListener("click", () => player.engine.seek(Number(p.dataset.t))));
  } else {
    els.lyrics.innerHTML = `<div class="lyrics-plain">${esc(result.text).replace(/\n/g, "<br>")}</div><div class="lyrics-src">${esc(result.source)}</div>`;
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

/* ───── sound of this track ───── */

const chips = (items, active, attr) => items.map((item) => `<button class="chip ${String(item.value) === String(active) ? "active" : ""}" data-${attr}="${item.value}" ${item.hint ? `title="${esc(item.hint)}"` : ""}>${esc(item.label)}</button>`).join("");

const FINE = [
  { key: "distance", label: "Дистанция", min: 0, max: 100, to: (v) => +(0.6 * 20 ** (v / 100)).toFixed(2), from: (s) => Math.round(Math.log(s / 0.6) / Math.log(20) * 100), fmt: (s) => `${s < 10 ? s.toFixed(1) : Math.round(s)} м` },
  { key: "motion", label: "Движение", min: 0, max: 100, to: (v) => v / 100, from: (s) => Math.round(s * 100), fmt: (s) => `${Math.round(s * 100)}%` },
  { key: "roomAmt", label: "Отражения", min: 0, max: 200, to: (v) => v / 100, from: (s) => Math.round(s * 100), fmt: (s) => `${Math.round(s * 100)}%` },
  { key: "bass", label: "Бас", min: 0, max: 16, to: (v) => v / 2, from: (s) => Math.round(s * 2), fmt: (s) => `+${s.toFixed(1)} dB` },
  { key: "width", label: "Ширина", min: 60, max: 160, to: (v) => v / 100, from: (s) => Math.round(s * 100), fmt: (s) => `${Math.round(s * 100)}%` },
  { key: "cue", label: "Чёткость 3D", min: 0, max: 100, to: (v) => v / 100, from: (s) => Math.round(s * 100), fmt: (s) => `${Math.round(s * 100)}%` },
];

function slider({ key, label, min, max, value, fmt, step = 1 }) {
  return `<label class="slider"><span>${label}<output>${fmt}</output></span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-key="${key}" /></label>`;
}

function speedKind(rate) { return rate < 1 ? "slowed" : rate > 1 ? "up" : "normal"; }

function renderSound() {
  const s = player.settings;
  const auto = player.soundMode === "auto";
  const kind = speedKind(s.rate);
  const preset = SCENE_PRESETS.find((p) => Object.entries(p.scene).every(([k, v]) => s[k] === v));
  const fit = (id) => ROOM_FIT[id] || "";
  const rooms = ROOMS.map((r) => ({ value: r.id, label: r.label, hint: fit(r.id) }));
  els.sound.innerHTML = `
    <div class="sound-head">
      <div><b>${auto ? "Автоматически" : "Свой звук трека"}</b><small>${auto ? `под ${esc(player.autoLabel())}` : "запомнен для этого трека"}</small></div>
      ${auto ? `<span class="pill-on">Авто</span>` : `<button class="btn ghost small" data-act="auto">Вернуть авто</button>`}
    </div>

    <div class="sblock">
      <div class="slabel">Скорость</div>
      <div class="seg wide">
        <button data-speed="slowed" class="${kind === "slowed" ? "active" : ""}">Slowed</button>
        <button data-speed="normal" class="${kind === "normal" ? "active" : ""}">Обычная</button>
        <button data-speed="up" class="${kind === "up" ? "active" : ""}">Speed up</button>
      </div>
      ${kind === "normal" ? "" : `<div class="chips">${SPEEDS[kind].map((r) => `<button class="chip ${s.rate === r ? "active" : ""}" data-rate="${r}">${Math.round(r * 100)}%</button>`).join("")}</div>`}
    </div>

    <div class="sblock">
      <div class="slabel">Reverb <button class="switch ${s.fxReverb ? "on" : ""}" data-act="reverb" aria-label="Reverb"></button></div>
      ${s.fxReverb ? slider({ key: "fxAmount", label: "Сила", min: 0, max: 100, value: Math.round(s.fxAmount * 100), fmt: `${Math.round(s.fxAmount * 100)}%` }) : ""}
    </div>

    <div class="sblock">
      <div class="slabel">Сцена</div>
      <div class="chips">${SCENE_PRESETS.map((p) => `<button class="chip ${preset?.id === p.id ? "active" : ""}" data-preset="${p.id}">${p.label}</button>`).join("")}</div>
    </div>

    <div class="sblock">
      <div class="slabel">Комната <small>${esc(findRoom(s.room).label)}${fit(s.room) ? ` · ${esc(fit(s.room))}` : ""}</small></div>
      <div class="chips">${chips(rooms, s.room, "room")}</div>
    </div>

    <div class="sblock">
      <div class="slabel">Атмосфера</div>
      <div class="chips">${chips(AMBIENCES.map((a) => ({ value: a.id, label: a.label })), s.ambience, "amb")}</div>
      ${s.ambience !== "none" ? slider({ key: "ambienceLevel", label: "Громкость", min: 0, max: 100, value: Math.round(s.ambienceLevel * 100), fmt: `${Math.round(s.ambienceLevel * 100)}%` }) : ""}
    </div>

    <button class="fine-toggle ${fine ? "open" : ""}" data-act="fine">Тонкая настройка <svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button>
    ${fine ? `<div class="sblock">
      <div class="slabel">Движение</div>
      <div class="chips">${chips(MODES.filter((m) => m.id !== "custom").map((m) => ({ value: m.id, label: m.label, hint: m.hint })), s.mode, "mode")}</div>
      ${FINE.map((f) => slider({ key: f.key, label: f.label, min: f.min, max: f.max, value: f.from(s[f.key]), fmt: f.fmt(s[f.key]) })).join("")}
    </div>` : ""}

    <div class="sound-foot">
      <button class="row-btn" data-act="spatial"><span>3D-звук</span><span class="switch ${s.spatial ? "on" : ""}"></span></button>
      <button class="row-btn" data-act="eq"><span>Эквалайзер</span><em>›</em></button>
    </div>`;

  const on = (sel, fn) => $$(sel, els.sound).forEach((el) => el.addEventListener("click", () => fn(el)));
  on('[data-act="auto"]', () => player.setAuto());
  on("[data-speed]", (el) => {
    const k = el.dataset.speed;
    player.setSpeed(k === "normal" ? 1 : k === "slowed" ? 0.85 : 1.2);
  });
  on("[data-rate]", (el) => player.setSpeed(Number(el.dataset.rate)));
  on('[data-act="reverb"]', () => player.toggleReverb());
  on("[data-preset]", (el) => player.adjust(SCENE_PRESETS.find((p) => p.id === el.dataset.preset).scene, { transition: true }));
  on("[data-room]", (el) => player.adjust({ room: el.dataset.room }));
  on("[data-amb]", (el) => player.adjust({ ambience: el.dataset.amb }));
  on("[data-mode]", (el) => player.adjust({ mode: el.dataset.mode }));
  on('[data-act="fine"]', () => { fine = !fine; renderSound(); });
  on('[data-act="spatial"]', () => player.toggleSpatial());
  on('[data-act="eq"]', () => { nowPlaying.hide(); navigate("settings", { focus: "eq" }); });
  $$("input[type=range]", els.sound).forEach((input) => {
    paintRange(input);
    input.addEventListener("input", () => {
      const key = input.dataset.key;
      const f = FINE.find((x) => x.key === key);
      const value = f ? f.to(Number(input.value)) : Number(input.value) / 100;
      player.adjust({ [key]: value });
      input.previousElementSibling.querySelector("output").textContent = f ? f.fmt(value) : `${Math.round(value * 100)}%`;
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
  const upcoming = player.queue.map((t, i) => ({ t, i })).filter(({ i }) => i > player.index);
  const now = player.track;
  els.queue.innerHTML = `
    ${now ? `<div class="qsec">Сейчас</div>${qrow(now, player.index, "now")}` : ""}
    <div class="qsec">Далее${upcoming.length ? ` · ${upcoming.length}` : ""}</div>
    ${upcoming.map(({ t, i }) => qrow(t, i, "")).join("") || `<div class="empty-note">Дальше пусто</div>`}`;
  $$(".qrow", els.queue).forEach((row) => row.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) { e.stopPropagation(); player.removeFromQueue(Number(rm.dataset.rm)); return; }
    if (!row.classList.contains("now")) player.playAt(Number(row.dataset.i));
  }));
}

function qrow(t, i, cls) {
  return `<div class="qrow ${cls}" data-i="${i}">${cover(t.cover, "xs")}<span><b>${esc(t.title)}</b><small>${esc(artistNames(t))}</small></span><em>${fmtTime(t.duration)}</em>${cls ? "<i></i>" : `<button class="icon-btn small" data-rm="${i}" title="Убрать">${ICON.trash}</button>`}</div>`;
}

/* ───── tabs ───── */

function setTab(name) {
  tab = name;
  $$("#npTabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$("#np .tab-panel").forEach((p) => { p.hidden = p.dataset.panel !== name; });
  renderAll();
  if (name === "lyrics") { lyricsState.index = -2; updateLyrics(player.engine.currentTime); }
}
$$("#npTabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
export const openSound = () => nowPlaying.show("sound");
export const openQueue = () => nowPlaying.show("queue");

function renderAll() {
  renderMeta();
  renderControls();
  loadLyrics();
  if (tab === "sound") renderSound();
  if (tab === "queue") renderQueue();
}

player.on("track", () => { lyricsState.trackId = null; if (nowPlaying.open) renderAll(); else loadLyrics(); });
player.on("state", renderControls);
player.on("loading", renderControls);
player.on("analyzed", () => { if (nowPlaying.open) { renderMeta(); if (tab === "sound") renderSound(); } });
player.on("settings", () => {
  if (tab === "sound" && nowPlaying.open && !document.activeElement?.matches?.("#soundPanel input")) renderSound();
  const mode = MODES.find((m) => m.id === player.settings.mode);
  els.immMode.textContent = `${mode?.label || ""} · ${findRoom(player.settings.room).label}`;
});
player.on("queue", () => { renderControls(); if (tab === "queue" && nowPlaying.open) renderQueue(); });

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
  if (nowPlaying.open) {
    const duration = engine.duration || player.track?.duration || 0;
    els.cur.textContent = fmtTime(time); els.dur.textContent = fmtTime(duration);
    if (!els.seek.matches(":active") && duration) { els.seek.value = Math.round(time / duration * 1000); paintRange(els.seek); }
  }
  const frame = { viz: engine.viz, energies: engine.energies, enabled: engine.stemEnabled, kick: engine.kick, view: "3d", editing: false, now };
  if (nowPlaying.open) stage.draw(frame);
  if (nowPlaying.immersive) immersiveStage.draw(frame);
  els.cover.style.transform = `scale(${1 + engine.kick * 0.016})`;
}

export { STYLE_SCENES };
