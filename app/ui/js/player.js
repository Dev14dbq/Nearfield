/*
  Playback: queue, the spatial engine and per-track scene choice (auto style or the active mood).
*/

import { api, fileUrl, plain } from "./api.js";
import { Engine } from "../engine/engine.js";
import { analyzeTrack } from "../engine/analysis.js";
import { DEFAULT_SETTINGS, STEM_NAMES } from "../engine/presets.js";
import { classifyStyle, findStyle, trackFeatures } from "../engine/style.js";
import { findMood } from "./moods.js";

const SCENE_KEYS = ["mode", "orbitBars", "room", "width", "distance", "motion", "roomAmt", "cue", "bass", "ambience", "ambienceLevel"];

class Player extends EventTarget {
  constructor() {
    super();
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.queue = [];
    this.index = -1;
    this.context = null; // { type: "playlist" | "mood" | "search" | …, label, id }
    this.mood = null;
    this.shuffle = false;
    this.repeat = "off"; // off | all | one
    this.volume = 0.85;
    this.loadingTrack = null;
    this.current = null; // library row of the playing track
    this.detected = null;
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
    const saved = await api.prefGet("settings", null);
    if (saved) {
      Object.keys(this.settings).forEach((key) => { if (key in saved && key !== "custom") this.settings[key] = saved[key]; });
    }
    this.settings.rate = this.settings.rate < 1 ? this.settings.slowRate : 1;
    this.volume = await api.prefGet("volume", 0.85);
    this.repeat = await api.prefGet("repeat", "off");
  }

  get track() { return this.queue[this.index] || null; }
  get playing() { return this.engine.playing; }

  /* ───── settings ───── */

  apply(patch, { transition = false, manual = true } = {}) {
    const previous = structuredClone(this.settings);
    Object.assign(this.settings, patch);
    // A hand-made scene stops automatic style switching (moods keep their own scene).
    if (manual && SCENE_KEYS.some((key) => key in patch)) { this.settings.autoStyle = false; this.settings.style = null; this.settings.experience = null; }
    const engine = this.engine;
    if (transition || (patch.mode && patch.mode !== previous.mode)) engine.transitionFrom(previous, transition ? 2 : 1.4);
    if ("rate" in patch) engine.setRate(this.settings.rate);
    if (["spatial", "headphone", "bass", "fxReverb", "fxAmount"].some((key) => key in patch)) engine.applyMix();
    if ("room" in patch || "distance" in patch) { clearTimeout(this.roomTimer); this.roomTimer = setTimeout(() => engine.applyRoom(), 220); }
    if ("ambience" in patch || "ambienceLevel" in patch) engine.applyAmbience();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => api.prefSet("settings", this.settings), 400);
    this.emit("settings");
  }

  setVolume(value) {
    this.volume = value;
    const master = this.engine.graph?.master;
    if (master) master.gain.setTargetAtTime(0.7 * value * value, this.engine.context.currentTime, 0.03);
    clearTimeout(this.volumeTimer);
    this.volumeTimer = setTimeout(() => api.prefSet("volume", value), 400);
  }

  toggleSlowed() { this.apply({ rate: this.settings.rate < 1 ? 1 : this.settings.slowRate }, { manual: false }); }
  toggleReverb() { this.apply({ fxReverb: !this.settings.fxReverb }, { manual: false }); }
  toggleSpatial() { this.apply({ spatial: !this.settings.spatial }, { manual: false }); }

  chooseStyle(id) {
    if (id === "auto") {
      this.settings.autoStyle = true;
      if (this.detected) this.applyStyle(this.detected.id);
      else this.emit("settings");
      return;
    }
    this.settings.autoStyle = false;
    this.applyStyle(id);
  }

  applyStyle(id) {
    const style = findStyle(id);
    this.apply({ ...style.settings, style: id, experience: null }, { transition: true, manual: false });
  }

  applyExperience(exp) {
    this.apply({ ambienceLevel: DEFAULT_SETTINGS.ambienceLevel, ...exp.settings, experience: exp.id, autoStyle: false, style: null }, { transition: true, manual: false });
  }

  /* ───── queue ───── */

  async playList(tracks, index = 0, context = null) {
    if (!tracks.length) return;
    this.mood = context?.type === "mood" ? findMood(context.id) : null;
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
    this.emit("queue");
  }

  addToQueue(tracks) {
    if (this.index < 0) { this.playList(tracks, 0, null); return; }
    this.queue.push(...tracks);
    this.emit("queue");
  }

  removeFromQueue(position) {
    if (position === this.index) return;
    this.queue.splice(position, 1);
    if (position < this.index) this.index -= 1;
    this.emit("queue");
  }

  setShuffle(on) {
    this.shuffle = on;
    if (on && this.index >= 0) {
      const rest = shuffled(this.queue.slice(this.index + 1));
      this.queue = [...this.queue.slice(0, this.index + 1), ...rest];
    }
    this.emit("queue");
  }

  cycleRepeat() {
    this.repeat = { off: "all", all: "one", one: "off" }[this.repeat];
    api.prefSet("repeat", this.repeat);
    this.emit("queue");
  }

  next(auto = false) {
    if (auto && this.repeat === "one") { this.engine.seek(0); this.engine.play(); return; }
    if (this.index + 1 < this.queue.length) this.playAt(this.index + 1);
    else if (this.repeat === "all" && this.queue.length) this.playAt(0);
    else if (this.mood && auto) this.emit("moodExhausted");
    else if (auto) { this.engine.pause(); this.engine.seek(0); }
  }

  prev() {
    if (this.engine.currentTime > 4 || this.index <= 0) { this.engine.seek(0); return; }
    this.playAt(this.index - 1);
  }

  async playAt(index) {
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
      // Skip what cannot be played instead of stopping the whole queue.
      setTimeout(() => { if (token === this.loadToken && this.index + 1 < this.queue.length) this.playAt(this.index + 1); }, 1200);
      return;
    }
    if (token !== this.loadToken) return;
    this.current = item;
    this.queue[index] = { ...track, ...item };
    this.emit("track", { track: this.queue[index] });
    const ready = item.stems && STEM_NAMES.every((stem) => item.stems[stem]);
    const engineTrack = {
      id: item.id, title: item.title, duration: item.duration,
      ...(ready ? { stems: Object.fromEntries(STEM_NAMES.map((stem) => [stem, fileUrl(item.stems[stem])])) } : { src: fileUrl(item.audio) }),
    };
    this.engineTrack = engineTrack;
    // Scene: the mood decides; otherwise a known style can be applied before analysis finishes.
    if (this.mood) this.applyMoodScene();
    else if (this.settings.autoStyle && item.analysis?.style) this.applyStyle(item.analysis.style);
    this.engine.loadTrack(engineTrack).catch((error) => this.emit("error", { message: String(error.message || error) }));
    try {
      await this.engine.play();
      this.setVolume(this.volume);
    } catch {
      this.emit("needsGesture");
    }
    this.loadingTrack = null;
    this.emit("loading", { loading: false });
    api.setListening(true);
    this.prefetch();
  }

  // Downloads the next track while this one plays, so skipping is instant.
  prefetch() {
    const next = this.queue[this.index + 1];
    if (next && !next.audio) api.preparePlay(next).then((item) => {
      const position = this.queue.indexOf(next);
      if (position >= 0) this.queue[position] = { ...next, ...item };
    }).catch(() => {});
  }

  applyMoodScene() {
    const scene = this.mood.scene;
    this.apply({ ambienceLevel: DEFAULT_SETTINGS.ambienceLevel, ...scene, experience: null, style: null }, { transition: true, manual: false });
  }

  async toggle() {
    if (this.engine.playing) { this.engine.pause(); api.setListening(false); }
    else if (this.track) {
      try { await this.engine.play(); api.setListening(true); } catch { this.emit("needsGesture"); }
    }
    this.emit("state");
  }

  onAnalyzed(engineTrack) {
    if (engineTrack !== this.engineTrack || !this.current) return;
    const features = computeFeatures(this.engine.buffers, this.engine.analysis, Boolean(engineTrack.stems));
    if (features.style) this.detected = { id: features.style, confidence: features.confidence, vocals: features.vocals };
    if (!this.mood && this.settings.autoStyle && this.detected && this.detected.id !== this.settings.style) this.applyStyle(this.detected.id);
    // Stereo-only analysis is replaced once stems are ready.
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

/* ───── background analysis ───── */

// Ready tracks are analysed while idle so moods and auto-style know them before they are played.
export async function analyzeInBackground(item) {
  const ctx = new OfflineAudioContext(2, 44100, 44100);
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
