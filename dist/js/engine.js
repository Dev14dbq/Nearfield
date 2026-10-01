import { renderAmbience } from "./ambience.js";
import { analyzeTrack, sampleEnvelope } from "./analysis.js";
import { blendFrames, choreograph } from "./choreography.js";
import { computeParams, PARAM_COUNT, SpatialGraph } from "./graph.js";
import { calibrate, measureGrid, syntheticGrid } from "./hrtf.js";
import { findRoom, STEM_NAMES, VOICES } from "./presets.js";
import { renderFxReverb, RoomLibrary } from "./rooms.js";
import { clamp, easeInOut } from "./util.js";

const MOTION_STEP = 0.02;

export class Engine {
  constructor(settings, hooks = {}) {
    this.settings = settings;
    this.hooks = { status: () => {}, changed: () => {}, analyzed: () => {}, ...hooks };
    this.context = null;
    this.graph = null;
    this.buffers = {};
    this.analysis = null;
    this.track = null;
    this.stemEnabled = Object.fromEntries(STEM_NAMES.map((stem) => [stem, true]));
    this.energies = Object.fromEntries(STEM_NAMES.map((stem) => [stem, 0]));
    this.playing = false;
    this.offset = 0;
    this.startedAt = 0;
    this.rate = settings.rate;
    this.duration = 0;
    this.players = [];
    this.loadToken = 0;
    this.loading = null;
    this.head = { yaw: 0, pitch: 0 };
    this.matchPower = { spatial: 0, bypass: 0 };
    this.scheduledUntil = 0;
    this.lastTick = 0;
    this.blend = null;
    this.values = new Float32Array(PARAM_COUNT);
    this.viz = VOICES.map(() => ({ x: 0, y: 0, z: -1, d: 1 }));
    this.roomKey = null;
    this.roomToken = 0;
    this.ambienceId = "none";
    this.ambienceToken = 0;
    this.ambienceCache = new Map();
  }

  /* ───── setup ───── */

  async init() {
    if (this.ready) return this.ready;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    // The engine always runs at 48 kHz: the browser resamples to the output device (96/192 kHz DACs
    // included). Everything was measured and tuned at this rate, and it is 2–4× lighter on the CPU.
    try { this.context = new AudioContext({ latencyHint: "balanced", sampleRate: 48000 }); } catch { this.context = new AudioContext({ latencyHint: "balanced" }); }
    this.ready = this.build();
    return this.ready;
  }

  async build() {
    const sampleRate = this.context.sampleRate;
    this.hooks.status("КАЛИБРОВКА HRTF", true);
    // A live HRTF panner keeps the browser's HRTF database loaded for the offline measurements too.
    this.hrtfKeepAlive = this.context.createPanner();
    this.hrtfKeepAlive.panningModel = "HRTF";
    let grid = await measureGrid(sampleRate).catch((error) => { console.warn("HRIR grid measurement failed", sampleRate, error); return null; });
    let calibration = await calibrate(sampleRate).catch((error) => { console.warn("HRTF calibration failed", sampleRate, error); return null; });
    // Never block playback on measurements: fall back to what we know, then to a spherical-head model.
    calibration ??= { latency: grid?.latency ?? 0.0064, eq: [], presence: [], frontEnergy: grid?.frontEnergy ?? 0.63 };
    grid ??= syntheticGrid(sampleRate, { latency: calibration.latency, frontEnergy: calibration.frontEnergy });
    this.calibration = calibration;
    this.grid = grid;
    this.offlineHrtf = grid.measured;
    this.rooms = new RoomLibrary(this.grid);
    this.graph = new SpatialGraph(this.context, this.calibration, { meters: true });
    STEM_NAMES.forEach((stem) => { this.graph.stems[stem].stemGain.gain.value = this.stemEnabled[stem] ? 1 : 0; });
    this.applyMix(true);
    this.updatePositions(0);
    this.graph.setNow(this.values);
    this.hooks.status(null);
    if (!grid.measured) {
      this.hooks.status("HRTF · УПРОЩЁННАЯ МОДЕЛЬ КОМНАТ", false, "hrtf");
      setTimeout(() => this.hooks.status(null, false, "hrtf"), 6000);
    }
    this.applyRoom();
    this.applyAmbience();
  }

  /* ───── settings ───── */

  applyMix(immediate = false) {
    if (!this.graph) return;
    const s = this.settings;
    this.graph.setMix({ spatial: s.spatial, headphone: s.headphone, bass: s.bass, fxReverb: s.fxReverb, fxAmount: s.fxAmount }, immediate ? 0.001 : 0.03);
    if (s.fxReverb) this.fxBuffer().then((buffer) => this.graph.setFxBuffer(buffer));
    this.updateAmbienceLevel();
  }

  updateAmbienceLevel() {
    if (!this.graph) return;
    const s = this.settings;
    const level = s.ambience !== "none" && this.playing ? s.ambienceLevel * 2 : 0;
    this.graph.setParam(this.graph.ambienceGain.gain, level, 0.35);
  }

  // Called with a snapshot of the previous settings when the scene changes: positions glide over.
  transitionFrom(previous, seconds = 1.6) {
    if (!this.context) return;
    const now = this.context.currentTime;
    this.blend = { settings: previous, start: now, end: now + seconds };
  }

  async applyRoom() {
    if (!this.rooms) return;
    const room = findRoom(this.settings.room);
    const token = ++this.roomToken;
    if (!room.dims) {
      if (this.roomKey !== "dry") this.graph.setRoom(null, 0.3);
      this.roomKey = "dry";
      return;
    }
    const key = `${room.id}|${RoomLibrary.distanceBucket(this.settings.distance)}`;
    if (key === this.roomKey) return;
    const slow = setTimeout(() => this.hooks.status(`КОМНАТА · ${room.label.toUpperCase()}`, true, "room"), 120);
    try {
      const data = await this.rooms.get(room, this.settings.distance);
      if (token !== this.roomToken) return;
      this.graph.setRoom(data, this.roomKey ? 0.3 : 0.05);
      this.roomKey = key;
    } catch (error) {
      console.error(error);
    } finally {
      clearTimeout(slow);
      if (token === this.roomToken) this.hooks.status(null, false, "room");
    }
  }

  fxBuffer() {
    this.fxPromise ??= renderFxReverb(this.grid);
    return this.fxPromise;
  }

  ambienceBuffer(id) {
    if (!this.ambienceCache.has(id)) this.ambienceCache.set(id, renderAmbience(id, this.grid));
    return this.ambienceCache.get(id);
  }

  async applyAmbience() {
    if (!this.graph) return;
    const id = this.settings.ambience;
    this.updateAmbienceLevel();
    if (id === this.ambienceId) return;
    const token = ++this.ambienceToken;
    this.ambienceId = id;
    if (id === "none") { this.graph.setAmbience(null); return; }
    const buffer = await this.ambienceBuffer(id);
    if (token !== this.ambienceToken) return;
    this.graph.setAmbience(buffer);
  }

  setStemEnabled(stem, enabled) {
    this.stemEnabled[stem] = enabled;
    const node = this.graph?.stems[stem];
    if (node) node.stemGain.gain.setTargetAtTime(enabled ? 1 : 0, this.context.currentTime, 0.018);
  }

  /* ───── transport ───── */

  get currentTime() {
    if (!this.playing || !this.context) return this.offset;
    return Math.min(this.duration, this.songTime(this.context.currentTime));
  }

  songTime(contextTime) {
    if (!this.playing) return this.offset;
    return this.offset + (contextTime - this.startedAt) * this.rate;
  }

  async loadTrack(track) {
    this.stopSources();
    this.playing = false;
    this.offset = 0;
    this.track = track;
    this.duration = track.duration || 0;
    this.buffers = {};
    this.analysis = null;
    const token = ++this.loadToken;
    STEM_NAMES.forEach((stem) => {
      this.stemEnabled[stem] = Boolean(track.stems?.[stem] || (stem === "other" && track.src));
      if (this.graph) this.graph.stems[stem].stemGain.gain.value = this.stemEnabled[stem] ? 1 : 0;
    });
    this.loading = (async () => {
      await this.init();
      const urls = STEM_NAMES.map((stem) => [stem, track.stems?.[stem] || (stem === "other" ? track.src : null)]).filter(([, url]) => url);
      let done = 0;
      this.hooks.status(`ЗАГРУЗКА СТЕМОВ 0/${urls.length}`, true);
      const decoded = await Promise.all(urls.map(async ([stem, url]) => {
        const data = await fetch(url).then((response) => { if (!response.ok) throw new Error(`${stem}: ${response.status}`); return response.arrayBuffer(); });
        const buffer = await this.context.decodeAudioData(data);
        done += 1;
        if (token === this.loadToken) this.hooks.status(`ЗАГРУЗКА СТЕМОВ ${done}/${urls.length}`, true);
        return [stem, buffer];
      }));
      if (token !== this.loadToken) return false;
      this.buffers = Object.fromEntries(decoded);
      this.duration = Math.max(...decoded.map(([, buffer]) => buffer.duration));
      this.hooks.status("АНАЛИЗ БИТА", true);
      const analysis = await analyzeTrack(this.buffers);
      if (token !== this.loadToken) return false;
      this.analysis = analysis;
      this.hooks.status(null);
      this.hooks.analyzed(track);
      this.hooks.changed();
      return true;
    })();
    return this.loading;
  }

  async play() {
    await this.init();
    if (this.context.state !== "running") await this.context.resume();
    const ok = await this.loading;
    if (!ok) return;
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    this.startSources(this.offset);
    this.updateAmbienceLevel();
    this.hooks.changed();
  }

  startSources(offset) {
    this.stopSources();
    const ctx = this.context;
    const when = ctx.currentTime + 0.04;
    this.players = Object.entries(this.buffers).map(([stem, buffer]) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = this.rate;
      const fade = this.graph.gain(0);
      fade.gain.setValueAtTime(0, when);
      fade.gain.linearRampToValueAtTime(1, when + 0.012);
      source.connect(fade); fade.connect(this.graph.stems[stem].input);
      source.start(when, Math.min(offset, buffer.duration));
      return { source, fade };
    });
    this.offset = offset;
    this.startedAt = when;
    this.playing = true;
  }

  stopSources() {
    if (!this.context) return;
    const now = this.context.currentTime;
    this.players.forEach(({ source, fade }) => {
      fade.gain.cancelScheduledValues(now);
      fade.gain.setValueAtTime(fade.gain.value, now);
      fade.gain.linearRampToValueAtTime(0, now + 0.012);
      try { source.stop(now + 0.02); } catch { /* already stopped */ }
      setTimeout(() => fade.disconnect(), 100);
    });
    this.players = [];
  }

  pause() {
    if (this.playing) this.offset = this.currentTime;
    this.stopSources();
    this.playing = false;
    this.updateAmbienceLevel();
    this.hooks.changed();
  }

  seek(seconds) {
    const target = clamp(seconds, 0, Math.max(0, this.duration - 0.05));
    if (this.playing) this.startSources(target); else this.offset = target;
  }

  // Slowed / nightcore: playback rate changes tempo and pitch together, like a turntable.
  setRate(rate) {
    if (rate === this.rate) return;
    if (this.playing && this.context) {
      const at = this.context.currentTime + 0.02;
      const position = this.songTime(at);
      this.players.forEach(({ source }) => source.playbackRate.setValueAtTime(rate, at));
      this.offset = position;
      this.startedAt = at;
    }
    this.rate = rate;
  }

  /* ───── motion ───── */

  frameAt(songT, contextT) {
    const s = this.settings;
    const target = choreograph(s.mode, songT, this.analysis, s);
    if (this.blend) {
      if (contextT >= this.blend.end) this.blend = null;
      else {
        const k = easeInOut(clamp((contextT - this.blend.start) / (this.blend.end - this.blend.start), 0, 1));
        const from = choreograph(this.blend.settings.mode, songT, this.analysis, this.blend.settings);
        return blendFrames(from, target, k);
      }
    }
    return target;
  }

  paramOptions() {
    const s = this.settings;
    return { sceneYaw: s.sceneYaw, cue: s.cue, roomAmt: s.roomAmt, roomOn: Boolean(this.graph?.room) && s.spatial };
  }

  updatePositions(contextT = this.context?.currentTime ?? 0) {
    const frame = this.frameAt(this.currentTime, contextT);
    computeParams(frame, this.paramOptions(), this.head, this.values, this.viz);
  }

  // Motion is written ahead onto the audio clock as short linear ramps, so it stays sample-locked
  // to the beat and keeps moving even when the tab is in the background and animation frames stop.
  scheduleMotion() {
    const now = this.context.currentTime;
    const horizon = document.hidden ? 1.6 : 0.05;
    if (this.scheduledUntil < now) this.scheduledUntil = now;
    const options = this.paramOptions();
    const values = new Float32Array(PARAM_COUNT);
    for (let at = this.scheduledUntil + MOTION_STEP; at <= now + horizon; at += MOTION_STEP) {
      computeParams(this.frameAt(this.songTime(at), at), options, this.head, values);
      this.graph.ramp(values, at, MOTION_STEP);
      this.scheduledUntil = at;
    }
  }

  updateEnergies() {
    const t = this.currentTime;
    STEM_NAMES.forEach((stem) => {
      const target = this.analysis && this.playing && this.stemEnabled[stem] ? sampleEnvelope(this.analysis.env[stem], t) : 0;
      this.energies[stem] += (target - this.energies[stem]) * 0.45;
    });
  }

  updateLoudnessMatch(dt) {
    if (!this.playing) return;
    const power = (meter) => {
      meter.analyser.getFloatTimeDomainData(meter.data);
      let sum = 0;
      for (let i = 0; i < meter.data.length; i += 1) sum += meter.data[i] * meter.data[i];
      return sum / meter.data.length;
    };
    const spatial = power(this.graph.meters.spatial); const bypass = power(this.graph.meters.bypass);
    if (bypass < 1e-6 || spatial < 1e-7) return;
    const k = 1 - Math.exp(-dt / 2.5);
    this.matchPower.spatial += (spatial - this.matchPower.spatial) * (this.matchPower.spatial ? k : 1);
    this.matchPower.bypass += (bypass - this.matchPower.bypass) * (this.matchPower.bypass ? k : 1);
    this.matchValue = clamp(Math.sqrt(this.matchPower.bypass / this.matchPower.spatial), 0.3, 3.5);
    this.graph.matchGain.gain.setTargetAtTime(this.matchValue, this.context.currentTime, 0.4);
  }

  tick() {
    if (!this.graph) return;
    const nowMs = performance.now();
    const dt = this.lastTick ? Math.min(0.25, (nowMs - this.lastTick) / 1000) : 0.016;
    this.lastTick = nowMs;
    this.updateEnergies();
    this.updatePositions();
    this.scheduleMotion();
    this.updateLoudnessMatch(dt);
  }

  get kick() {
    return this.playing && this.analysis ? sampleEnvelope(this.analysis.kick, this.currentTime) : 0;
  }
}
