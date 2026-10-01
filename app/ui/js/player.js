/*
  Playback: queue, the spatial engine, and the sound of each track.
  Every track sounds either automatic (style or mood picks the scene) or the way the user set it
  for that very track — those settings are remembered per track.
*/

import { api, fileUrl, plain } from "./api.js";
import { Engine } from "../engine/engine.js";
import { analyzeTrack } from "../engine/analysis.js";
import { DEFAULT_SETTINGS, STEM_NAMES } from "../engine/presets.js";
import { classifyStyle, trackFeatures } from "../engine/style.js";
import { findMood } from "./moods.js";
import { autoSound, forgetSound, pickSound, saveSound, savedSound, styleFromGenre, STYLE_SCENES } from "./scenes.js";

const ENGINE_KEYS_MIX = ["spatial", "headphone", "bass", "fxReverb", "fxAmount"];

export const EQ_PRESETS = [
  { id: "flat", label: "Ровно", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: "bass", label: "Больше баса", gains: [5, 4, 3, 1, 0, 0, 0, 0, 0, 0] },
  { id: "vocal", label: "Голос", gains: [-2, -1, 0, 0, 1, 2.5, 3, 2, 0, 0] },
  { id: "bright", label: "Яркость", gains: [0, 0, 0, 0, 0, 0, 1, 2.5, 3.5, 4] },
  { id: "warm", label: "Тепло", gains: [2, 2, 1.5, 1, 0, 0, -1, -1.5, -2, -2] },
  { id: "loud", label: "Громкость", gains: [4, 3, 1, 0, -1, -1, 0, 1.5, 3, 3.5] },
];

class Player extends EventTarget {
  constructor() {
    super();
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.settings.ambience = "none";
    this.queue = [];
    this.index = -1;
    this.context = null;
    this.mood = null;
    this.shuffle = false;
    this.repeat = "off";
    this.volume = 0.85;
    this.eq = EQ_PRESETS[0].gains.slice();
    this.loadingTrack = null;
    this.current = null;
    this.detected = null;
    this.soundMode = "auto"; // "auto" | "track" (saved for this track)
    this.loadToken = 0;
    this.engine = new Engine(this.settings, {
      status: (text, busy) => this.emit("status", { text, busy }),
      changed: () => this.emit("state"),
      analyzed: (track) => this.onAnalyzed(track),
    });
  }

  emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, handler) { this.addEventListener(type, (event) => handler(event.detail)); }

  async restore() {
    const global = await api.prefGet("global", null);
    if (global) ["spatial", "headphone"].forEach((key) => { if (key in global) this.settings[key] = global[key]; });
    this.volume = await api.prefGet("volume", 0.85);
    this.repeat = await api.prefGet("repeat", "off");
    this.shuffle = await api.prefGet("shuffle", false);
    this.eq = await api.prefGet("eq", this.eq);
  }

  get track() { return this.queue[this.index] || null; }
  get playing() { return this.engine.playing; }

  /* ───── sound ───── */

  // Low-level: pushes a settings patch into the engine.
  set(patch, { transition = false } = {}) {
    const previous = structuredClone(this.settings);
    Object.assign(this.settings, patch);
    const engine = this.engine;
    if (transition || (patch.mode && patch.mode !== previous.mode)) engine.transitionFrom(previous, transition ? 1.6 : 1.2);
    if ("rate" in patch && patch.rate !== previous.rate) engine.setRate(this.settings.rate);
    if (ENGINE_KEYS_MIX.some((key) => key in patch)) engine.applyMix();
    if ("room" in patch || "distance" in patch) { clearTimeout(this.roomTimer); this.roomTimer = setTimeout(() => engine.applyRoom(), 200); }
    if ("ambience" in patch || "ambienceLevel" in patch) engine.applyAmbience();
    this.emit("settings");
  }

  /** The user changed something for the current track: it is remembered for this track. */
  adjust(patch, options) {
    this.set(patch, options);
    if (!this.track) return;
    this.soundMode = "track";
    clearTimeout(this.soundTimer);
    const id = this.track.id;
    this.soundTimer = setTimeout(() => saveSound(id, pickSound(this.settings)), 300);
  }

  async setAuto() {
    if (!this.track) return;
    await forgetSound(this.track.id);
    this.soundMode = "auto";
    this.applyAuto();
  }

  autoStyle() {
    return this.detected?.id || this.current?.analysis?.style || styleFromGenre(this.track?.genre) || "pop";
  }

  autoLabel() {
    if (this.mood) return `настроение «${this.mood.label}»`;
    const style = this.autoStyle();
    return (STYLE_SCENES[style] || STYLE_SCENES.pop).label.toLowerCase();
  }

  applyAuto() {
    this.set(autoSound({ style: this.autoStyle(), mood: this.mood }), { transition: true });
  }

  setGlobal(patch) {
    this.set(patch);
    api.prefSet("global", { spatial: this.settings.spatial, headphone: this.settings.headphone });
  }

  setVolume(value) {
    this.volume = value;
    const master = this.engine.graph?.master;
    if (master) master.gain.setTargetAtTime(0.7 * value * value, this.engine.context.currentTime, 0.03);
    clearTimeout(this.volumeTimer);
    this.volumeTimer = setTimeout(() => api.prefSet("volume", value), 400);
  }

  setEq(gains) {
    this.eq = gains.slice();
    this.engine.graph?.setUserEq(this.eq);
    clearTimeout(this.eqTimer);
    this.eqTimer = setTimeout(() => api.prefSet("eq", this.eq), 300);
    this.emit("eq");
  }

  toggleSpatial() { this.setGlobal({ spatial: !this.settings.spatial }); }
  setSpeed(rate) { this.adjust({ rate }); }
  toggleReverb() { this.adjust({ fxReverb: !this.settings.fxReverb }); }

  /* ───── queue ───── */

  async playList(tracks, index = 0, context = null) {
    if (!tracks.length) return;
    this.mood = moodOf(context);
    this.context = context;
    this.queue = tracks.slice();
    if (this.shuffle) {
      const [first] = this.queue.splice(index, 1);
      this.queue = [first, ...shuffled(this.queue)];
      index = 0;
    }
    await this.playAt(index);
  }

  addNext(track) {
    if (this.index < 0) { this.playList([track], 0, null); return; }
    this.queue.splice(this.index + 1, 0, track);
    this.emit("queue"); this.saveSession();
  }

  addToQueue(tracks) {
    if (this.index < 0) { this.playList(tracks, 0, null); return; }
    this.queue.push(...tracks);
    this.emit("queue"); this.saveSession();
  }

  removeFromQueue(position) {
    if (position === this.index) return;
    this.queue.splice(position, 1);
    if (position < this.index) this.index -= 1;
    this.emit("queue"); this.saveSession();
  }

  setShuffle(on) {
    this.shuffle = on;
    api.prefSet("shuffle", on);
    if (on && this.index >= 0) this.queue = [...this.queue.slice(0, this.index + 1), ...shuffled(this.queue.slice(this.index + 1))];
    this.emit("queue");
  }

  cycleRepeat() {
    this.repeat = { off: "all", all: "one", one: "off" }[this.repeat];
    api.prefSet("repeat", this.repeat);
    this.emit("queue");
  }

  next(auto = false) {
    if (this.track) this.emit("advance", { track: this.track, played: this.engine.currentTime, auto });
    if (auto && this.repeat === "one") { this.engine.seek(0); this.engine.play(); return; }
    if (this.index + 1 < this.queue.length) this.playAt(this.index + 1);
    else if (this.repeat === "all" && this.queue.length) this.playAt(0);
    else if (this.mood && auto) this.emit("moodExhausted");
    else if (auto) { this.engine.pause(); this.engine.seek(0); this.emit("state"); }
  }

  prev() {
    if (this.engine.currentTime > 4 || this.index <= 0) { this.engine.seek(0); return; }
    this.playAt(this.index - 1);
  }

  async playAt(index, { autoplay = true, startAt = 0 } = {}) {
    const token = ++this.loadToken;
    this.index = index;
    const track = this.queue[index];
    this.loadingTrack = track;
    this.current = null;
    this.detected = null;
    if (this.engine.playing) this.engine.pause();
    this.emit("track", { track });
    this.emit("loading", { loading: true });
    let item;
    try {
      item = await api.preparePlay(track);
    } catch (error) {
      if (token !== this.loadToken) return;
      this.loadingTrack = null;
      this.emit("loading", { loading: false });
      this.emit("error", { message: `${track.title}: ${error}` });
      if (autoplay) setTimeout(() => { if (token === this.loadToken && this.index + 1 < this.queue.length) this.playAt(this.index + 1); }, 1200);
      return;
    }
    if (token !== this.loadToken) return;
    this.current = item;
    this.queue[index] = { ...track, ...item };
    this.emit("track", { track: this.queue[index] });

    // The track's own sound if the user set one, otherwise automatic.
    const saved = await savedSound(track.id);
    if (token !== this.loadToken) return;
    if (saved) { this.soundMode = "track"; this.set({ ...autoSound({ style: this.autoStyle(), mood: null }), ...saved }, { transition: true }); }
    else { this.soundMode = "auto"; this.applyAuto(); }

    const ready = item.stems && STEM_NAMES.every((stem) => item.stems[stem]);
    const engineTrack = {
      id: item.id, title: item.title, duration: item.duration,
      ...(ready ? { stems: Object.fromEntries(STEM_NAMES.map((stem) => [stem, fileUrl(item.stems[stem])])) } : { src: fileUrl(item.audio) }),
    };
    this.engineTrack = engineTrack;
    this.engine.loadTrack(engineTrack).catch((error) => this.emit("error", { message: String(error.message || error) }));
    await this.engine.init();
    this.engine.graph?.setUserEq(this.eq);
    if (startAt) { await this.engine.loading; this.engine.seek(startAt); }
    if (autoplay) {
      try {
        await this.engine.play();
        this.setVolume(this.volume);
      } catch {
        this.emit("needsGesture");
      }
      api.setListening(true);
    } else {
      this.setVolume(this.volume);
    }
    this.loadingTrack = null;
    this.emit("loading", { loading: false });
    this.emit("state");
    this.saveSession();
    this.prefetch();
  }

  prefetch() {
    const next = this.queue[this.index + 1];
    if (next && !next.audio) api.preparePlay(next).then((item) => {
      const position = this.queue.indexOf(next);
      if (position >= 0) this.queue[position] = { ...next, ...item };
    }).catch(() => {});
  }

  async toggle() {
    if (this.engine.playing) { this.engine.pause(); api.setListening(false); this.saveSession(); }
    else if (this.track) {
      try { await this.engine.play(); this.setVolume(this.volume); api.setListening(true); } catch { this.emit("needsGesture"); }
    }
    this.emit("state");
  }

  /* ───── session ───── */

  saveSession() {
    if (!this.track) return;
    const start = Math.max(0, this.index - 50);
    api.prefSet("session", {
      queue: this.queue.slice(start, start + 200).map(plain),
      index: this.index - start,
      time: Math.round(this.engine.currentTime),
      context: this.context,
    });
  }

  async restoreSession() {
    const session = await api.prefGet("session", null);
    if (!session?.queue?.length) return false;
    this.context = session.context;
    this.mood = moodOf(session.context);
    this.queue = session.queue;
    await this.playAt(Math.min(session.index, session.queue.length - 1), { autoplay: false, startAt: session.time || 0 });
    return true;
  }

  /* ───── analysis ───── */

  onAnalyzed(engineTrack) {
    if (engineTrack !== this.engineTrack || !this.current) return;
    const features = computeFeatures(this.engine.buffers, this.engine.analysis, Boolean(engineTrack.stems));
    const before = this.autoStyle();
    if (features.style) this.detected = { id: features.style, confidence: features.confidence, vocals: features.vocals };
    if (this.soundMode === "auto" && !this.mood && this.autoStyle() !== before) this.applyAuto();
    if (!this.current.analysis || (features.stems && !this.current.analysis.stems)) {
      api.saveAnalysis(this.current.id, features).catch(() => {});
      this.current.analysis = features;
    }
    this.emit("analyzed", { features });
  }
}

export function computeFeatures(buffers, analysis, hasStems) {
  const base = { v: 1, bpm: Math.round(analysis.bpm), stems: hasStems };
  const kickMean = analysis.kick.reduce((sum, v) => sum + v, 0) / Math.max(1, analysis.kick.length);
  if (!hasStems) return { ...base, drive: Math.min(1, kickMean * 6) };
  const f = trackFeatures(buffers, analysis);
  const style = classifyStyle(f);
  return {
    ...base,
    style: style.id, confidence: +style.confidence.toFixed(2), vocals: style.vocals,
    vocalPresence: +f.vocalPresence.toFixed(2), drive: +(f.share.drums + f.share.bass).toFixed(2),
    brightness: Math.round(f.brightness), dynamics: +f.dynamics.toFixed(1), pump: +f.pump.toFixed(2),
  };
}

// Ready tracks are analysed while idle so moods and auto sound know them before they are played.
export async function analyzeInBackground(item) {
  const ctx = new OfflineAudioContext(2, 48000, 48000);
  const buffers = {};
  for (const stem of STEM_NAMES) {
    const data = await fetch(fileUrl(item.stems[stem])).then((r) => r.arrayBuffer());
    buffers[stem] = await ctx.decodeAudioData(data);
  }
  const analysis = await analyzeTrack(buffers);
  const features = computeFeatures(buffers, analysis, true);
  await api.saveAnalysis(item.id, features);
  return features;
}

// A context may carry its own scene (a mood or a wave setting); then every track uses it in auto mode.
function moodOf(context) {
  if (context?.scene) return { id: context.id, label: context.label, scene: context.scene };
  if (context?.type === "mood") return findMood(context.id);
  return null;
}

function shuffled(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const player = new Player();
export { plain };
