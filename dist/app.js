const STEM_NAMES = ["vocals", "bass", "drums", "other"];

const STEM_META = {
  vocals: { label: "VOCAL", room: 0.55, color: "#67e8f9" },
  bass: { label: "BASS", room: 0.12, color: "#dfff4f" },
  drums: { label: "DRUMS", room: 0.42, color: "#ff9f67" },
  other: { label: "MUSIC", room: 0.85, color: "#f3f4ef" },
};

// Every stem is split into a mono centre (mid) and a decorrelated pair (side) so the
// lead stays locked in front while doubles, reverbs and wide synths can move around you.
// Drums additionally get an "air" band (hats, shakers, cymbals) that is choreographed to the beat.
const VOICES = [
  { id: "vox-mid", stem: "vocals", band: "main", part: "mid" },
  { id: "vox-l", stem: "vocals", band: "main", part: "sideL" },
  { id: "vox-r", stem: "vocals", band: "main", part: "sideR" },
  { id: "bass-mid", stem: "bass", band: "main", part: "mid" },
  { id: "bass-l", stem: "bass", band: "main", part: "sideL" },
  { id: "bass-r", stem: "bass", band: "main", part: "sideR" },
  { id: "kit-mid", stem: "drums", band: "body", part: "mid" },
  { id: "kit-l", stem: "drums", band: "body", part: "sideL" },
  { id: "kit-r", stem: "drums", band: "body", part: "sideR" },
  { id: "hat-l", stem: "drums", band: "air", part: "left" },
  { id: "hat-r", stem: "drums", band: "air", part: "right" },
  { id: "mus-mid", stem: "other", band: "main", part: "mid" },
  { id: "mus-l", stem: "other", band: "main", part: "sideL" },
  { id: "mus-r", stem: "other", band: "main", part: "sideR" },
];

// Below this frequency nothing is localised by the ear, so lows skip HRTF entirely and stay punchy.
const CROSSOVER_HZ = 140;
const AIR_HZ = 6500;

function stemSet(folder) {
  return Object.fromEntries(STEM_NAMES.map((stem) => [stem, `assets/stems/${folder}/${stem}.mp3`]));
}

const TRACKS = [
  { title: "Poker Face", artist: "Lady Gaga", album: "The Fame Monster", duration: 237.27, stems: stemSet("poker-face"), cover: "assets/covers/poker-face.jpg" },
  { title: "Love Me Not", artist: "Ravyn Lenae", album: "Love Me Not / Love Is Blind", duration: 213.525, stems: stemSet("love-me-not"), cover: "assets/covers/love-me-not.jpg" },
];

const SCENES = {
  intimate: { spread: 0.78, distance: 0.8, room: 0.14, depth: 0.6, motion: 0.45, ir: { predelay: 0.003, rt60: 0.42, size: 0.6, bright: 7200 } },
  studio: { spread: 1, distance: 1, room: 0.24, depth: 0.74, motion: 0.68, ir: { predelay: 0.008, rt60: 0.8, size: 1, bright: 6400 } },
  stage: { spread: 1.22, distance: 1.25, room: 0.34, depth: 0.88, motion: 0.82, ir: { predelay: 0.017, rt60: 1.5, size: 1.7, bright: 5200 } },
};

const els = {
  audioGate: document.querySelector("#audioGate"), cover: document.querySelector("#cover"),
  currentTime: document.querySelector("#currentTime"), depth: document.querySelector("#depth"),
  depthValue: document.querySelector("#depthValue"), dialog: document.querySelector("#infoDialog"),
  duration: document.querySelector("#duration"), engineStatus: document.querySelector("#engineStatus"),
  fileInput: document.querySelector("#fileInput"), headphoneToggle: document.querySelector("#headphoneToggle"),
  motion: document.querySelector("#motion"), motionValue: document.querySelector("#motionValue"),
  nextButton: document.querySelector("#nextButton"), playButton: document.querySelector("#playButton"),
  prevButton: document.querySelector("#prevButton"), room: document.querySelector("#room"),
  roomValue: document.querySelector("#roomValue"), seek: document.querySelector("#seek"),
  spatialToggle: document.querySelector("#spatialToggle"), spectrumCanvas: document.querySelector("#spectrumCanvas"),
  stageCanvas: document.querySelector("#stageCanvas"), trackArtist: document.querySelector("#trackArtist"),
  trackList: document.querySelector("#trackList"), trackTitle: document.querySelector("#trackTitle"),
  trackingButton: document.querySelector("#trackingButton"), trackingState: document.querySelector("#trackingState"),
  bpmValue: document.querySelector("#bpmValue"),
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const mod = (value, n) => ((value % n) + n) % n;
const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/* ───────────────────────── Offline beat & energy analysis ───────────────────────── */

const FPS = 100;

function percentile(values, p) {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] || 0;
}

function biquadCoeffs(type, frequency, q, sampleRate) {
  const w = 2 * Math.PI * frequency / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0; let b1; let b2;
  if (type === "lowpass") { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; }
  else if (type === "highpass") { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; }
  else { b0 = alpha; b1 = 0; b2 = -alpha; }
  const a0 = 1 + alpha;
  return [b0 / a0, b1 / a0, b2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
}

function monoChannel(buffer) {
  const left = buffer.getChannelData(0);
  if (buffer.numberOfChannels < 2) return left;
  const right = buffer.getChannelData(1);
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i += 1) mono[i] = (left[i] + right[i]) * 0.5;
  return mono;
}

function rmsEnvelope(samples, frames, hop) {
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) {
    const start = Math.floor(f * hop); const end = Math.min(samples.length, Math.floor((f + 1) * hop));
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
    env[f] = end > start ? Math.sqrt(sum / (end - start)) : 0;
  }
  const ref = percentile(env, 0.95) || 1;
  for (let f = 0; f < frames; f += 1) env[f] = Math.min(1, env[f] / ref);
  return env;
}

function bandEnergies(samples, frames, hop, sampleRate, bands) {
  return bands.map(([type, frequency, q]) => {
    const [b0, b1, b2, a1, a2] = biquadCoeffs(type, frequency, q, sampleRate);
    const energy = new Float32Array(frames);
    let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
    for (let f = 0; f < frames; f += 1) {
      const start = Math.floor(f * hop); const end = Math.min(samples.length, Math.floor((f + 1) * hop));
      let sum = 0;
      for (let i = start; i < end; i += 1) {
        const x = samples[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        sum += y * y;
      }
      energy[f] = end > start ? sum / (end - start) : 0;
    }
    return energy;
  });
}

function onsetStrength(energy) {
  const onset = new Float32Array(energy.length);
  const log = energy.map((value) => Math.log10(1e-9 + value));
  for (let f = 2; f < energy.length; f += 1) onset[f] = Math.max(0, log[f] - Math.max(log[f - 1], log[f - 2]) * 0.5 - log[f - 2] * 0.5);
  const positives = onset.filter((value) => value > 0);
  const ref = positives.length ? percentile(positives, 0.985) : 1;
  for (let f = 0; f < onset.length; f += 1) onset[f] = Math.min(1, onset[f] / ref);
  return onset;
}

function hitEnvelope(onset, release) {
  const env = new Float32Array(onset.length);
  const decay = Math.exp(-1 / (FPS * release));
  for (let f = 0; f < onset.length; f += 1) env[f] = Math.max(onset[f], (env[f - 1] || 0) * decay);
  return env;
}

function estimatePeriod(onset) {
  const n = onset.length;
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += onset[i];
  mean /= n;
  const weighted = [];
  for (let lag = 25; lag <= 115; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < n; i += 1) sum += (onset[i] - mean) * (onset[i + lag] - mean);
    const prior = Math.exp(-0.5 * (Math.log2(lag / 50) / 0.9) ** 2);
    weighted[lag] = (sum / (n - lag)) * prior;
  }
  let best = 50;
  for (let lag = 26; lag < 115; lag += 1) if (weighted[lag] > weighted[best]) best = lag;
  const a = weighted[best - 1] ?? weighted[best]; const b = weighted[best]; const c = weighted[best + 1] ?? weighted[best];
  const denominator = a - 2 * b + c;
  return best + (denominator ? clamp(0.5 * (a - c) / denominator, -0.5, 0.5) : 0);
}

// Dynamic-programming beat tracker (Ellis, 2007): beats land on strong onsets while staying near the tempo.
function trackBeats(onset, period) {
  const n = onset.length;
  let sq = 0;
  for (let i = 0; i < n; i += 1) sq += onset[i] * onset[i];
  const norm = Math.sqrt(sq / n) || 1;
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const minLag = Math.round(period / 2); const maxLag = Math.round(period * 2);
  for (let t = 0; t < n; t += 1) {
    let best = -Infinity; let arg = -1;
    for (let tau = Math.max(0, t - maxLag); tau <= t - minLag; tau += 1) {
      const value = score[tau] - 100 * Math.log((t - tau) / period) ** 2;
      if (value > best) { best = value; arg = tau; }
    }
    const local = onset[t] / norm;
    if (arg >= 0 && best > 0) { score[t] = local + best; back[t] = arg; } else score[t] = local;
  }
  let last = n - 1;
  for (let t = Math.max(0, n - Math.round(period * 2)); t < n; t += 1) if (score[t] > score[last]) last = t;
  const beats = [];
  for (let t = last; t >= 0; t = back[t]) beats.push(t);
  return beats.reverse();
}

function localMax(arr, center, radius = 3) {
  let max = 0;
  for (let i = Math.max(0, center - radius); i <= Math.min(arr.length - 1, center + radius); i += 1) max = Math.max(max, arr[i]);
  return max;
}

function meanRange(arr, start, end) {
  start = clamp(Math.round(start), 0, arr.length); end = clamp(Math.round(end), 0, arr.length);
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += arr[i];
  return sum / (end - start);
}

async function analyzeTrack(buffers) {
  const available = STEM_NAMES.filter((stem) => buffers[stem]);
  const sampleRate = buffers[available[0]].sampleRate;
  const hop = sampleRate / FPS;
  const frames = Math.ceil(Math.max(...available.map((stem) => buffers[stem].length)) / hop);
  const env = {};
  for (const stem of STEM_NAMES) {
    env[stem] = buffers[stem] ? rmsEnvelope(monoChannel(buffers[stem]), frames, hop) : new Float32Array(frames);
    await yieldToUI();
  }

  const rhythmSource = monoChannel(buffers.drums || buffers.other || buffers[available[0]]);
  const [kickEnergy, snareEnergy, hatEnergy] = bandEnergies(rhythmSource, frames, hop, sampleRate, [
    ["lowpass", 95, 0.8], ["bandpass", 2300, 0.6], ["highpass", 8000, 0.7],
  ]);
  await yieldToUI();
  const kickOnset = onsetStrength(kickEnergy);
  const snareOnset = onsetStrength(snareEnergy);
  const hatOnset = onsetStrength(hatEnergy);
  const onset = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) onset[f] = kickOnset[f] + 0.8 * snareOnset[f] + 0.45 * hatOnset[f];

  const period = estimatePeriod(onset);
  const beatFrames = trackBeats(onset, period);
  await yieldToUI();

  // Section intensity: weighted loudness smoothed over ~1.5 s in both directions, mapped to 0..1.
  const total = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) total[f] = env.vocals[f] * 0.6 + env.bass[f] + env.drums[f] + env.other[f];
  const k = 1 - Math.exp(-1 / (FPS * 1.5));
  for (let f = 1; f < frames; f += 1) total[f] += (total[f - 1] - total[f]) * (1 - k);
  for (let f = frames - 2; f >= 0; f -= 1) total[f] += (total[f + 1] - total[f]) * (1 - k);
  const low = percentile(total, 0.15); const high = percentile(total, 0.92);
  const intensity = total.map((value) => clamp((value - low) / Math.max(1e-6, high - low), 0, 1));

  // Downbeat: kicks on 1/3, snares on 2/4, sections start on a bar line.
  const rise = (i, span) => meanRange(intensity, beatFrames[i] ?? frames, beatFrames[i + span] ?? frames) - meanRange(intensity, beatFrames[i - span] ?? 0, beatFrames[i] ?? 0);
  let downbeat = 0; let bestDownbeat = -Infinity;
  for (let phase = 0; phase < 4; phase += 1) {
    let score = 0;
    for (let i = phase; i < beatFrames.length; i += 4) score += localMax(kickOnset, beatFrames[i]) - 0.5 * localMax(snareOnset, beatFrames[i]) + 3 * Math.max(0, rise(i, 4));
    if (score > bestDownbeat) { bestDownbeat = score; downbeat = phase; }
  }
  let phrase = downbeat; let bestPhrase = -Infinity;
  for (let bar = 0; bar < 8; bar += 1) {
    let score = 0;
    for (let i = downbeat + bar * 4; i < beatFrames.length; i += 32) score += Math.abs(rise(i, 8));
    if (score > bestPhrase) { bestPhrase = score; phrase = downbeat + bar * 4; }
  }

  const beats = Float64Array.from(beatFrames, (frame) => frame / FPS);
  const intervals = [];
  for (let i = 1; i < beats.length; i += 1) intervals.push(beats[i] - beats[i - 1]);
  const beatPeriod = intervals.length ? percentile(intervals, 0.5) : period / FPS;
  return {
    frames, beats, beatPeriod, bpm: 60 / beatPeriod, downbeat, phrase, env, intensity,
    kick: hitEnvelope(kickOnset, 0.16), snare: hitEnvelope(snareOnset, 0.2), hat: hitEnvelope(hatOnset, 0.09),
  };
}

function sampleEnvelope(arr, time) {
  if (!arr) return 0;
  const position = time * FPS;
  const index = Math.floor(position);
  if (index < 0) return arr[0] || 0;
  if (index >= arr.length - 1) return arr[arr.length - 1] || 0;
  return arr[index] + (arr[index + 1] - arr[index]) * (position - index);
}

function beatIndexAt(analysis, time) {
  const beats = analysis?.beats;
  if (!beats || beats.length < 2) return time * 2;
  if (time <= beats[0]) return (time - beats[0]) / analysis.beatPeriod;
  const last = beats.length - 1;
  if (time >= beats[last]) return last + (time - beats[last]) / analysis.beatPeriod;
  let lo = 0; let hi = last;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (beats[mid] <= time) lo = mid; else hi = mid; }
  return lo + (time - beats[lo]) / (beats[lo + 1] - beats[lo]);
}

/* ───────────────────────── Choreography ───────────────────────── */

// Returns azimuth (deg, + = right), elevation (deg), distance and gain for every voice at song time t.
function choreograph(t, analysis, settings) {
  const { motion: m, depth, scene } = settings;
  const playing = Boolean(analysis);
  const bi = playing ? beatIndexAt(analysis, t) : 0;
  const phraseBeat = playing ? mod(bi - analysis.phrase, 32) : 0;
  const I = playing ? sampleEnvelope(analysis.intensity, t) : 0.6;
  const kick = playing ? sampleEnvelope(analysis.kick, t) : 0;
  const snare = playing ? sampleEnvelope(analysis.snare, t) : 0;
  const voice = playing ? sampleEnvelope(analysis.env.vocals, t) : 0;
  const width = scene.spread * (0.6 + 0.62 * depth) * (0.86 + 0.24 * I);
  const near = scene.distance * (0.82 + 0.32 * depth);
  const tau = Math.PI * 2;
  const wide = (deg) => clamp(deg * width, 0, 150);

  // Last two beats of every 8-bar phrase: hats fly once around your head.
  const fill = m >= 0.35 && phraseBeat >= 30 ? easeInOut((phraseBeat - 30) / 2) * 360 : 0;
  const hatSwing = m * 52 * Math.sin(Math.PI * bi);
  const musicSway = m * 30 * Math.sin(tau * bi / 32);
  const backingSway = m * 20 * Math.sin(tau * bi / 16);
  const hit = Math.max(kick, snare);
  const pump = 1 - 0.2 * kick * m;

  return {
    "vox-mid": { az: 0, el: 4, d: 1 - 0.12 * voice * m, g: 1 },
    "vox-l": { az: -wide(64 + 16 * I) + backingSway, el: 12, d: 1.15, g: 1 },
    "vox-r": { az: wide(64 + 16 * I) + backingSway, el: 12, d: 1.15, g: 1 },
    "bass-mid": { az: 0, el: -12, d: 0.95, g: 1 },
    "bass-l": { az: -wide(34), el: -8, d: 1, g: 1 },
    "bass-r": { az: wide(34), el: -8, d: 1, g: 1 },
    "kit-mid": { az: 0, el: 2 + 16 * snare * m, d: 1.08 - 0.1 * kick * m, g: 1 },
    "kit-l": { az: -wide(46 + 26 * hit * m), el: 6, d: 1.18, g: 1 },
    "kit-r": { az: wide(46 + 26 * hit * m), el: 6, d: 1.18, g: 1 },
    "hat-l": { az: hatSwing + fill - wide(36), el: 22, d: 1.05, g: 1 },
    "hat-r": { az: hatSwing + fill + wide(36), el: 22, d: 1.05, g: 1 },
    "mus-mid": { az: m * 14 * Math.sin(tau * bi / 8), el: 0, d: 1.32 + 0.18 * kick * m, g: pump },
    "mus-l": { az: -wide(88) + musicSway, el: 6 + 8 * m * Math.sin(tau * bi / 16), d: 1.4 + 0.3 * kick * m, g: pump },
    "mus-r": { az: wide(88) + musicSway, el: 6 - 8 * m * Math.sin(tau * bi / 16), d: 1.4 + 0.3 * kick * m, g: pump },
    near,
  };
}

/* ───────────────────────── Audio engine ───────────────────────── */

class SpatialEngine {
  constructor() {
    this.context = null;
    this.desiredStemState = Object.fromEntries(STEM_NAMES.map((stem) => [stem, true]));
    this.stemNodes = {};
    this.sources = VOICES.map((voice) => ({ ...voice, x: 0, y: 0, z: -1 }));
    this.buffers = {};
    this.analysis = null;
    this.yaw = 0;
    this.depth = 0.74;
    this.roomAmount = 0.24;
    this.motion = 0.68;
    this.spatialEnabled = true;
    this.headphoneEnabled = true;
    this.playing = false;
    this.offset = 0;
    this.startedAt = 0;
    this.duration = 0;
    this.players = [];
    this.loadToken = 0;
    this.loading = null;
    this.matchPower = { spatial: 0, bypass: 0 };
    this.lastTick = 0;
    this.scheduledUntil = 0;
  }

  get currentTime() {
    if (!this.playing || !this.context) return this.offset;
    return Math.min(this.duration, this.offset + this.context.currentTime - this.startedAt);
  }

  songTime(contextTime) {
    if (!this.playing) return this.offset;
    return this.offset + contextTime - this.startedAt;
  }

  async init() {
    if (this.context) return this.ready;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContext({ latencyHint: "playback" });
    this.ready = this.build();
    return this.ready;
  }

  async build() {
    const ctx = this.context;
    const calibration = await this.calibrate().catch(() => ({ latency: 0, eq: [], presence: [] }));
    this.latency = calibration.latency;
    this.presence = calibration.presence;

    this.hrtfBus = this.gain(1);
    this.lowBus = this.gain(1);
    this.roomBus = this.gain(1);
    this.bypassBus = this.gain(1);
    this.spatialSum = this.gain(1);
    this.matchGain = this.gain(1);
    this.spatialSwitch = this.gain(1);
    this.bypassSwitch = this.gain(0);
    this.outBus = this.gain(1);
    this.master = this.gain(0.7);

    // HRTF path → measured inverse EQ so the front of the scene sounds like the original mix.
    this.compensation = calibration.eq.map(([frequency, gain, q]) => this.filter("peaking", frequency, q, gain));
    this.connectChain([this.hrtfBus, ...this.compensation, this.spatialSum]);

    // Lows: one Linkwitz-Riley crossover, delayed by the HRTF latency so everything stays phase-aligned.
    const lowDelay = ctx.createDelay(0.1); lowDelay.delayTime.value = this.latency;
    this.connectChain([this.lowBus, this.filter("lowpass", CROSSOVER_HZ, Math.SQRT1_2), this.filter("lowpass", CROSSOVER_HZ, Math.SQRT1_2), lowDelay, this.spatialSum]);

    // Room: band-limited send into one of three pre-built rooms (crossfaded on scene change).
    const roomIn = this.gain(1);
    this.connectChain([this.roomBus, this.filter("highpass", 220, 0.7), this.filter("lowpass", 9000, 0.7), roomIn]);
    this.rooms = Object.fromEntries(Object.entries(SCENES).map(([name, scene]) => {
      const convolver = ctx.createConvolver();
      convolver.normalize = false;
      convolver.buffer = this.createRoomImpulse(scene.ir);
      const level = this.gain(name === app.scene ? 1 : 0);
      roomIn.connect(level); level.connect(convolver); convolver.connect(this.spatialSum);
      return [name, level];
    }));

    const bypassDelay = ctx.createDelay(0.1); bypassDelay.delayTime.value = this.latency;
    this.connectChain([this.bypassBus, bypassDelay, this.bypassSwitch, this.outBus]);
    this.connectChain([this.spatialSum, this.matchGain, this.spatialSwitch, this.outBus]);

    // Loudness meters (K-weighted) keep 3D and 2D at the same perceived level for a fair A/B.
    const silent = this.gain(0); silent.connect(ctx.destination);
    this.meters = {
      spatial: this.meter(this.spatialSum, silent),
      bypass: this.meter(this.bypassBus, silent),
    };

    this.eqFilters = [
      this.filter("lowshelf", 105, 0.7, -1.7), this.filter("peaking", 260, 0.86, -1.4),
      this.filter("peaking", 2450, 1, 1.9), this.filter("peaking", 6100, 1.25, -1.15),
      this.filter("highshelf", 9400, 0.7, 0.85),
    ];
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.12;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.83;
    this.connectChain([this.outBus, ...this.eqFilters, this.master, this.limiter, this.analyser, ctx.destination]);

    STEM_NAMES.forEach((stem) => this.createStem(stem));
    this.updateMix(true);
    this.updatePositions(0);
    this.sources.forEach(({ panner, level, x, y, z }) => {
      if (panner.positionX) { panner.positionX.value = x; panner.positionY.value = y; panner.positionZ.value = z; }
      else panner.setPosition(x, y, z);
      level.gain.value = 1;
    });
  }

  gain(value) { const node = this.context.createGain(); node.gain.value = value; return node; }

  filter(type, frequency, q, gain = 0) {
    const node = this.context.createBiquadFilter();
    // Web Audio reads lowpass/highpass Q in dB, peaking/bandpass Q linearly; callers always pass linear Q.
    const resonanceInDb = type === "lowpass" || type === "highpass";
    node.type = type; node.frequency.value = frequency; node.Q.value = resonanceInDb ? 20 * Math.log10(q) : q; node.gain.value = gain;
    return node;
  }

  connectChain(nodes) { nodes.reduce((previous, node) => { previous.connect(node); return node; }); }

  meter(node, sink) {
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 2048;
    this.connectChain([node, this.filter("highpass", 120, 0.5), this.filter("highshelf", 1700, 0.7, 4), analyser, sink]);
    return { analyser, data: new Float32Array(analyser.fftSize) };
  }

  mono(value = 1) {
    const node = this.gain(value);
    node.channelCount = 1; node.channelCountMode = "explicit"; node.channelInterpretation = "speakers";
    return node;
  }

  // Measures the browser's own HRTF set: its latency and its tonal colouring in front of the listener.
  async calibrate() {
    const sampleRate = this.context.sampleRate;
    const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const render = async (azimuth) => {
      const length = 8192;
      const offline = new OfflineContext(2, length, sampleRate);
      const impulse = offline.createBuffer(1, length, sampleRate);
      impulse.getChannelData(0)[0] = 1;
      const source = offline.createBufferSource(); source.buffer = impulse;
      const panner = offline.createPanner();
      panner.panningModel = "HRTF"; panner.rolloffFactor = 0;
      const a = azimuth * Math.PI / 180;
      if (panner.positionX) { panner.positionX.value = Math.sin(a); panner.positionY.value = 0; panner.positionZ.value = -Math.cos(a); }
      else panner.setPosition(Math.sin(a), 0, -Math.cos(a));
      source.connect(panner); panner.connect(offline.destination); source.start();
      const rendered = await offline.startRendering();
      return [rendered.getChannelData(0), rendered.getChannelData(1)];
    };
    // Weighted like the actual layout: centre voices up front, kit and hats at ±20–45°, wide music and doubles at ±70–90°.
    const responses = [[0, 4], [-20, 1], [20, 1], [-45, 1], [45, 1], [-70, 0.8], [70, 0.8], [-90, 0.8], [90, 0.8]];
    const irs = await Promise.all(responses.map(([azimuth]) => render(azimuth)));
    const [frontL, frontR] = irs[0];
    let peak = 0; let peakIndex = 0;
    for (let i = 0; i < frontL.length; i += 1) {
      const value = Math.abs(frontL[i]) + Math.abs(frontR[i]);
      if (value > peak) { peak = value; peakIndex = i; }
    }
    if (peak < 1e-4) throw new Error("HRTF database not ready");

    const nyquist = sampleRate / 2;
    const freqs = [];
    for (let f = 100; f < Math.min(18000, nyquist * 0.9); f *= 2 ** (1 / 8)) freqs.push(f);
    const power = (ir, f) => {
      const w = 2 * Math.PI * f / sampleRate; let re = 0; let im = 0;
      for (let n = 0; n < ir.length; n += 1) { if (ir[n]) { re += ir[n] * Math.cos(w * n); im -= ir[n] * Math.sin(w * n); } }
      return re * re + im * im;
    };
    // Weighted ear-averaged power response, ~1/2-octave smoothed: correct the broad tonal tilt,
    // never chase individual pinna notches.
    const spectrum = (indices) => {
      const weightSum = indices.reduce((sum, i) => sum + responses[i][1], 0);
      const raw = freqs.map((f) => 10 * Math.log10(indices.reduce((sum, i) => sum + responses[i][1] * (power(irs[i][0], f) + power(irs[i][1], f)) / 2, 0) / weightSum + 1e-12));
      return raw.map((_, i) => { let sum = 0; for (let j = -2; j <= 2; j += 1) sum += raw[clamp(i + j, 0, raw.length - 1)]; return sum / 5; });
    };
    const interpolate = (db, f) => {
      let i = 0; while (i < freqs.length - 2 && freqs[i + 1] < f) i += 1;
      const x = clamp(Math.log(f / freqs[i]) / Math.log(freqs[i + 1] / freqs[i]), 0, 1);
      return db[i] + (db[i + 1] - db[i]) * x;
    };
    const fit = (centers, q, target) => {
      const probes = Float32Array.from(centers);
      const filters = centers.map((frequency) => this.filter("peaking", frequency, q, 0));
      const gains = centers.map(() => 0);
      const mag = new Float32Array(centers.length); const phase = new Float32Array(centers.length);
      for (let iteration = 0; iteration < 120; iteration += 1) {
        const total = centers.map(() => 0);
        filters.forEach((node, i) => {
          node.gain.value = gains[i];
          node.getFrequencyResponse(probes, mag, phase);
          mag.forEach((value, j) => { total[j] += 20 * Math.log10(value); });
        });
        centers.forEach((frequency, i) => { gains[i] = clamp(gains[i] + 0.4 * (target(frequency) - total[i]), -8, 10); });
      }
      const response = (f) => filters.reduce((sum, node) => {
        node.getFrequencyResponse(Float32Array.of(f), mag.subarray(0, 1), phase.subarray(0, 1));
        return sum + 20 * Math.log10(mag[0]);
      }, 0);
      return { bands: centers.map((frequency, i) => [frequency, +gains[i].toFixed(2), q]), response };
    };
    const fade = (f) => (f > 14000 ? clamp(1 - (f - 14000) / 4000, 0, 1) : 1);

    // Global EQ on the whole HRTF bus. Absolute target: it must meet the bypassed lows at unity gain.
    const average = spectrum(responses.map((_, i) => i));
    const global = fit([190, 300, 480, 760, 1200, 1900, 3000, 4700, 6800, 9300, 12500].filter((f) => f < nyquist * 0.8), 1.15,
      (f) => clamp(-interpolate(average, f), -6, 9) * fade(f));
    // Centre voices (lead vocal, kick/snare body, bass, music core) sit where the HRTF dip is deepest,
    // so they get an extra presence correction on top of the global one.
    const front = spectrum([0]);
    const presence = fit([2600, 4200, 6400, 8800, 11500].filter((f) => f < nyquist * 0.8), 1.4,
      (f) => (f < 2000 ? 0 : clamp(-(interpolate(front, f) + global.response(f)), -6, 7) * fade(f)));
    return { latency: peakIndex / sampleRate, eq: global.bands, presence: presence.bands };
  }

  createStem(stem) {
    const ctx = this.context;
    const input = this.gain(1);
    const stemGain = this.gain(this.desiredStemState[stem] ? 1 : 0);
    input.connect(stemGain);
    stemGain.connect(this.bypassBus);
    stemGain.connect(this.lowBus);
    const highs = this.filter("highpass", CROSSOVER_HZ, Math.SQRT1_2);
    const highs2 = this.filter("highpass", CROSSOVER_HZ, Math.SQRT1_2);
    stemGain.connect(highs); highs.connect(highs2);
    const bands = { main: highs2 };
    if (stem === "drums") {
      const body = this.filter("lowpass", AIR_HZ, Math.SQRT1_2); const body2 = this.filter("lowpass", AIR_HZ, Math.SQRT1_2);
      const air = this.filter("highpass", AIR_HZ, Math.SQRT1_2); const air2 = this.filter("highpass", AIR_HZ, Math.SQRT1_2);
      this.connectChain([highs2, body, body2]); this.connectChain([highs2, air, air2]);
      bands.body = body2; bands.air = air2;
    }

    const parts = {};
    Object.entries(bands).forEach(([band, node]) => {
      const stereo = this.gain(1);
      stereo.channelCount = 2; stereo.channelCountMode = "explicit"; stereo.channelInterpretation = "speakers";
      node.connect(stereo);
      const splitter = ctx.createChannelSplitter(2);
      stereo.connect(splitter);
      const mid = this.mono(1); stereo.connect(mid);
      const side = this.mono(0.5); const invertRight = this.mono(-1); const sideInverted = this.mono(-1);
      splitter.connect(side, 0); splitter.connect(invertRight, 1); invertRight.connect(side); side.connect(sideInverted);
      const left = this.mono(1); const right = this.mono(1);
      splitter.connect(left, 0); splitter.connect(right, 1);
      parts[band] = { mid, sideL: side, sideR: sideInverted, left, right };
    });

    this.sources.filter((source) => source.stem === stem).forEach((source) => {
      const level = this.mono(1);
      const panner = ctx.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.rolloffFactor = 0;
      panner.channelCount = 1; panner.channelCountMode = "explicit";
      const send = this.mono(0);
      parts[source.band][source.part].connect(level);
      const presence = source.part === "mid" ? this.presence.map(([frequency, gain, q]) => this.filter("peaking", frequency, q, gain)) : [];
      this.connectChain([level, ...presence, panner]);
      panner.connect(this.hrtfBus);
      level.connect(send); send.connect(this.roomBus);
      Object.assign(source, { level, panner, send });
    });

    this.stemNodes[stem] = { input, stemGain, enabled: this.desiredStemState[stem], energy: 0 };
  }

  createRoomImpulse({ predelay, rt60, size, bright }) {
    const ctx = this.context;
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * (predelay + rt60 * 1.1 + 0.05));
    const impulse = ctx.createBuffer(2, length, sampleRate);
    let seed = 481516;
    const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const taps = [[3, 7.5, 11, 17, 23.5, 31], [4.5, 9.2, 13.5, 19.5, 27, 35.5]];
    for (let channel = 0; channel < 2; channel += 1) {
      const data = impulse.getChannelData(channel);
      let lowpassed = 0;
      for (let i = 0; i < length; i += 1) {
        const t = i / sampleRate - predelay;
        if (t < 0) continue;
        const cutoff = Math.max(1400, bright * Math.exp(-t / (rt60 * 0.55)));
        const coefficient = 1 - Math.exp(-2 * Math.PI * cutoff / sampleRate);
        lowpassed += ((random() * 2 - 1) - lowpassed) * coefficient;
        const fadeIn = Math.min(1, t / (0.012 * size + 0.006));
        data[i] = lowpassed * Math.exp(-6.91 * t / rt60) * fadeIn;
      }
      taps[channel].forEach((ms, index) => {
        const sample = Math.floor((predelay + ms * size / 1000) * sampleRate);
        if (sample < length) data[sample] += (index % 2 ? -1 : 1) * 0.5 / (1 + index * 0.45);
      });
      let energy = 0;
      for (let i = 0; i < length; i += 1) energy += data[i] * data[i];
      const scale = 1 / Math.sqrt(energy || 1);
      for (let i = 0; i < length; i += 1) data[i] *= scale;
    }
    return impulse;
  }

  async loadTrack(track) {
    this.stopSources();
    this.playing = false;
    this.offset = 0;
    this.duration = track.duration || 0;
    this.buffers = {};
    this.analysis = null;
    const token = ++this.loadToken;
    STEM_NAMES.forEach((stem) => {
      const available = Boolean(track.stems?.[stem] || (stem === "other" && track.src));
      this.desiredStemState[stem] = available;
      if (this.stemNodes[stem]) { this.stemNodes[stem].enabled = available; this.stemNodes[stem].stemGain.gain.value = available ? 1 : 0; }
    });
    this.loading = (async () => {
      await this.init();
      const urls = STEM_NAMES.map((stem) => [stem, track.stems?.[stem] || (stem === "other" ? track.src : null)]).filter(([, url]) => url);
      let done = 0;
      setStatus(`ЗАГРУЗКА СТЕМОВ 0/${urls.length}`, true);
      const decoded = await Promise.all(urls.map(async ([stem, url]) => {
        const data = await fetch(url).then((response) => { if (!response.ok) throw new Error(`${stem}: ${response.status}`); return response.arrayBuffer(); });
        const buffer = await this.context.decodeAudioData(data);
        done += 1;
        if (token === this.loadToken) setStatus(`ЗАГРУЗКА СТЕМОВ ${done}/${urls.length}`, true);
        return [stem, buffer];
      }));
      if (token !== this.loadToken) return false;
      this.buffers = Object.fromEntries(decoded);
      this.duration = Math.max(...decoded.map(([, buffer]) => buffer.duration));
      setStatus("АНАЛИЗ БИТА", true);
      const analysis = await analyzeTrack(this.buffers);
      if (token !== this.loadToken) return false;
      this.analysis = analysis;
      updatePlaybackUI();
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
    updatePlaybackUI();
  }

  startSources(offset) {
    this.stopSources();
    const ctx = this.context;
    const when = ctx.currentTime + 0.04;
    this.players = Object.entries(this.buffers).map(([stem, buffer]) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const fade = this.gain(0);
      fade.gain.setValueAtTime(0, when);
      fade.gain.linearRampToValueAtTime(1, when + 0.012);
      source.connect(fade); fade.connect(this.stemNodes[stem].input);
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
    updatePlaybackUI();
  }

  seek(seconds) {
    const target = clamp(seconds, 0, Math.max(0, this.duration - 0.05));
    if (this.playing) this.startSources(target); else this.offset = target;
  }

  setStemEnabled(stem, enabled) {
    this.desiredStemState[stem] = enabled;
    const node = this.stemNodes[stem];
    if (!node) return;
    node.enabled = enabled;
    node.stemGain.gain.setTargetAtTime(enabled ? 1 : 0, this.context.currentTime, 0.018);
  }

  updateEnergies() {
    const t = this.currentTime;
    STEM_NAMES.forEach((stem) => {
      const node = this.stemNodes[stem];
      const target = this.analysis && this.playing && this.desiredStemState[stem] ? sampleEnvelope(this.analysis.env[stem], t) : 0;
      if (node) node.energy += (target - node.energy) * 0.45;
    });
  }

  // Places every voice for a given song time; returns world positions after head/scene rotation.
  computeFrame(time) {
    const scene = SCENES[app.scene];
    const frame = choreograph(time, this.playing ? this.analysis : null, { motion: this.motion, depth: this.depth, scene });
    const cosYaw = Math.cos(this.yaw); const sinYaw = Math.sin(this.yaw);
    return this.sources.map((source) => {
      const { az, el, d, g } = frame[source.id];
      const distance = d * frame.near;
      const a = az * Math.PI / 180; const e = el * Math.PI / 180;
      const x = Math.sin(a) * Math.cos(e) * distance;
      const z = -Math.cos(a) * Math.cos(e) * distance;
      const room = STEM_META[source.stem].room * (source.band === "air" ? 0.7 : 1);
      return {
        x: x * cosYaw - z * sinYaw, y: Math.sin(e) * distance, z: x * sinYaw + z * cosYaw,
        levelValue: g * clamp(Math.pow(1 / distance, 0.55), 0.55, 1.35),
        sendValue: this.spatialEnabled ? this.roomAmount * room * (0.55 + 0.45 * distance) : 0,
      };
    });
  }

  updatePositions(time = this.currentTime) {
    this.computeFrame(time).forEach((position, index) => Object.assign(this.sources[index], position));
  }

  // Motion is written ahead onto the audio clock as short linear ramps, so it stays sample-locked
  // to the beat and keeps moving even when the tab is in the background and animation frames stop.
  scheduleMotion() {
    const now = this.context.currentTime;
    const horizon = document.hidden ? 1.6 : 0.06;
    const step = document.hidden ? 0.03 : 0.02;
    if (this.scheduledUntil < now) this.scheduledUntil = now;
    const legacy = !this.sources[0].panner.positionX;
    for (let at = this.scheduledUntil + step; at <= now + horizon; at += step) {
      this.computeFrame(this.songTime(at)).forEach((position, index) => {
        const { panner, level, send } = this.sources[index];
        if (!legacy) {
          panner.positionX.linearRampToValueAtTime(position.x, at);
          panner.positionY.linearRampToValueAtTime(position.y, at);
          panner.positionZ.linearRampToValueAtTime(position.z, at);
        }
        level.gain.linearRampToValueAtTime(position.levelValue, at);
        send.gain.linearRampToValueAtTime(position.sendValue, at);
      });
      this.scheduledUntil = at;
    }
    if (legacy) this.sources.forEach((source) => source.panner.setPosition(source.x, source.y, source.z));
  }

  updateMix(immediate = false) {
    if (!this.context || !this.spatialSwitch) return;
    const now = this.context.currentTime;
    const constant = immediate ? 0.001 : 0.03;
    this.spatialSwitch.gain.setTargetAtTime(this.spatialEnabled ? 1 : 0, now, constant);
    this.bypassSwitch.gain.setTargetAtTime(this.spatialEnabled ? 0 : 1, now, constant);
    Object.entries(this.rooms).forEach(([name, level]) => level.gain.setTargetAtTime(name === app.scene ? 1 : 0, now, 0.08));
    const targetGains = [-1.7, -1.4, 1.9, -1.15, 0.85];
    this.eqFilters.forEach((filter, index) => filter.gain.setTargetAtTime(this.headphoneEnabled ? targetGains[index] : 0, now, constant));
    this.master.gain.setTargetAtTime(this.headphoneEnabled ? 0.66 : 0.74, now, constant);
  }

  updateLoudnessMatch(dt) {
    if (!this.playing) return;
    const power = (meter) => {
      meter.analyser.getFloatTimeDomainData(meter.data);
      let sum = 0;
      for (let i = 0; i < meter.data.length; i += 1) sum += meter.data[i] * meter.data[i];
      return sum / meter.data.length;
    };
    const spatial = power(this.meters.spatial); const bypass = power(this.meters.bypass);
    if (bypass < 1e-6 || spatial < 1e-7) return;
    const k = 1 - Math.exp(-dt / 2.5);
    this.matchPower.spatial += (spatial - this.matchPower.spatial) * (this.matchPower.spatial ? k : 1);
    this.matchPower.bypass += (bypass - this.matchPower.bypass) * (this.matchPower.bypass ? k : 1);
    const gain = clamp(Math.sqrt(this.matchPower.bypass / this.matchPower.spatial), 0.5, 2);
    this.matchGain.gain.setTargetAtTime(gain, this.context.currentTime, 0.4);
  }

  tick() {
    if (!this.context || !this.spatialSwitch) return;
    const nowMs = performance.now();
    const dt = this.lastTick ? Math.min(0.25, (nowMs - this.lastTick) / 1000) : 0.016;
    this.lastTick = nowMs;
    this.updateEnergies();
    this.updatePositions();
    this.scheduleMotion();
    this.updateLoudnessMatch(dt);
  }
}

const engine = new SpatialEngine();
const app = { trackIndex: 0, scene: "studio", dragging: false, lastX: 0, tracking: false, baseHeading: null, status: null };

function setStatus(text, busy = false) {
  app.status = text ? { text, busy } : null;
  updatePlaybackUI();
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

function updateRange(input) {
  const min = Number(input.min || 0); const max = Number(input.max || 100);
  input.style.setProperty("--fill", `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

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
  const loading = engine.loadTrack(track);
  loading.then((ok) => { if (ok) setStatus(null); }).catch((error) => setStatus(`ОШИБКА · ${error.message}`.toUpperCase()));
  els.cover.src = track.cover; els.cover.alt = `Обложка ${track.title}`;
  els.trackTitle.textContent = track.title; els.trackArtist.textContent = track.artist;
  els.duration.textContent = formatTime(track.duration); els.currentTime.textContent = "0:00";
  els.seek.value = 0; updateRange(els.seek);
  document.querySelectorAll(".stem-chip").forEach((chip) => {
    const available = Boolean(track.stems) || chip.dataset.stem === "other";
    chip.classList.toggle("active", available); chip.disabled = !available;
    chip.setAttribute("aria-pressed", String(available));
  });
  renderTracks();
  if (autoplay || wasPlaying) engine.play().catch(showAudioGate);
}

function togglePlayback() { if (engine.playing) engine.pause(); else engine.play().catch(showAudioGate); }
function showAudioGate() {
  els.audioGate.dataset.mode = "audio";
  els.audioGate.querySelector("span").textContent = "Браузер приостановил аудио";
  els.audioGate.querySelector("button").textContent = "ПРОДОЛЖИТЬ";
  els.audioGate.hidden = false;
}
function updatePlaybackUI() {
  els.playButton.classList.toggle("playing", engine.playing);
  els.playButton.setAttribute("aria-label", engine.playing ? "Пауза" : "Воспроизвести");
  els.trackList.querySelector(".track-row.active")?.classList.toggle("playing-row", engine.playing);
  const bpm = engine.analysis ? `${Math.round(engine.analysis.bpm)} BPM` : "— BPM";
  if (els.bpmValue) els.bpmValue.textContent = bpm;
  document.querySelector(".engine-status")?.classList.toggle("busy", Boolean(app.status?.busy));
  els.engineStatus.textContent = app.status?.text || (engine.playing ? `HRTF · ${bpm}` : "AI ДВИЖОК ГОТОВ");
}

function applyScene(name) {
  app.scene = name;
  const settings = SCENES[name];
  els.depth.value = Math.round(settings.depth * 100); els.room.value = Math.round(settings.room * 100);
  els.motion.value = Math.round(settings.motion * 100); updateControls();
  document.querySelectorAll("[data-scene]").forEach((button) => button.classList.toggle("active", button.dataset.scene === name));
}

function updateControls() {
  engine.depth = Number(els.depth.value) / 100; engine.roomAmount = Number(els.room.value) / 100;
  engine.motion = Number(els.motion.value) / 100;
  els.depthValue.value = `${els.depth.value}%`; els.roomValue.value = `${els.room.value}%`; els.motionValue.value = `${els.motion.value}%`;
  [els.depth, els.room, els.motion].forEach(updateRange);
  engine.updateMix(); engine.updatePositions(); drawStage();
}

function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr)); const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  return { width: rect.width, height: rect.height, dpr };
}

function drawStage() {
  const { width, height, dpr } = fitCanvas(els.stageCanvas); const ctx = els.stageCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
  const cx = width / 2; const cy = height * 0.55; const maxR = Math.min(width, height) * 0.38;
  const t = engine.currentTime;
  const kick = engine.playing && engine.analysis ? sampleEnvelope(engine.analysis.kick, t) : 0;
  ctx.strokeStyle = "rgba(241,244,234,.085)"; ctx.lineWidth = 1;
  [0.36, 0.68, 1].forEach((scale) => { ctx.beginPath(); ctx.arc(cx, cy, maxR * scale, 0, Math.PI * 2); ctx.stroke(); });
  ctx.beginPath(); ctx.moveTo(cx, 18); ctx.lineTo(cx, height - 22); ctx.moveTo(24, cy); ctx.lineTo(width - 24, cy); ctx.stroke();
  if (kick > 0.02) {
    ctx.strokeStyle = `rgba(223,255,79,${0.5 * kick})`; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, 18 + (1 - kick) * maxR * 0.3, 0, Math.PI * 2); ctx.stroke();
  }
  engine.sources.forEach((source) => {
    const meta = STEM_META[source.stem];
    const radius = Math.hypot(source.x, source.z); const limit = Math.min(1, 2.1 / Math.max(radius, 1e-3));
    const px = cx + source.x * limit * maxR * 0.46; const py = cy + source.z * limit * maxR * 0.46;
    const energy = engine.stemNodes[source.stem]?.energy || 0;
    const enabled = engine.desiredStemState[source.stem];
    const main = source.part === "mid";
    ctx.globalAlpha = enabled ? 1 : 0.25;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(px, py); ctx.strokeStyle = `${meta.color}24`; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath(); ctx.arc(px, py, (main ? 4.8 : 3.2) + energy * (main ? 3.8 : 2.4), 0, Math.PI * 2);
    ctx.fillStyle = meta.color; ctx.shadowColor = meta.color; ctx.shadowBlur = 8 + energy * 16; ctx.fill(); ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  });
  ctx.fillStyle = "#0b0d0f"; ctx.strokeStyle = "#dfff4f"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - 6, cy - 1); ctx.quadraticCurveTo(cx, cy - 8, cx + 6, cy - 1); ctx.stroke();
  ctx.fillStyle = "#dfff4f"; ctx.font = "700 8px Space Mono"; ctx.textAlign = "center"; ctx.fillText("YOU", cx, cy + 30);
}

function updateStemMeters() {
  document.querySelectorAll(".stem-chip").forEach((chip) => {
    const energy = engine.stemNodes[chip.dataset.stem]?.energy || 0;
    chip.querySelector("em").style.width = `${Math.max(4, energy * 100)}%`;
  });
}

function drawSpectrum() {
  engine.tick();
  const { width, height, dpr } = fitCanvas(els.spectrumCanvas); const ctx = els.spectrumCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
  const count = Math.max(36, Math.floor(width / 9)); let values;
  if (engine.analyser) { values = new Uint8Array(engine.analyser.frequencyBinCount); engine.analyser.getByteFrequencyData(values); }
  const center = height / 2; const gap = width / count;
  for (let i = 0; i < count; i += 1) {
    const index = values ? Math.floor(Math.pow(i / count, 1.7) * values.length) : i;
    const idle = 0.08 + 0.13 * Math.sin(i * 1.67 + performance.now() / 1200) ** 2;
    const energy = values ? values[index] / 255 : idle; const bar = Math.max(2, energy * center * 0.88);
    ctx.fillStyle = `rgba(223,255,79,${0.24 + energy * 0.76})`;
    ctx.fillRect(i * gap + 1, center - bar, Math.max(2, gap - 4), bar * 2);
  }
  const duration = engine.duration || TRACKS[app.trackIndex].duration;
  const current = engine.currentTime;
  els.currentTime.textContent = formatTime(current); els.duration.textContent = formatTime(duration);
  if (!els.seek.matches(":active") && duration) { els.seek.value = Math.round(current / duration * 1000); updateRange(els.seek); }
  checkTrackEnd();
  updateStemMeters(); drawStage(); requestAnimationFrame(drawSpectrum);
}

function checkTrackEnd() {
  if (engine.playing && engine.duration && engine.currentTime >= engine.duration - 0.03) selectTrack(app.trackIndex + 1, true);
}

// Animation frames stop in background tabs; this keeps motion scheduled and playlists advancing.
setInterval(() => { if (document.hidden) { engine.tick(); checkTrackEnd(); } }, 250);

async function enableTracking() {
  if (app.tracking) {
    app.tracking = false; window.removeEventListener("deviceorientation", onOrientation); engine.yaw = 0;
    engine.updatePositions(); updateTrackingUI(); return;
  }
  try {
    if (typeof DeviceOrientationEvent?.requestPermission === "function") {
      const permission = await DeviceOrientationEvent.requestPermission(); if (permission !== "granted") return;
    }
    if (!("DeviceOrientationEvent" in window)) throw new Error("Нет гироскопа");
    app.tracking = true; app.baseHeading = null; window.addEventListener("deviceorientation", onOrientation); updateTrackingUI();
  } catch { els.trackingState.textContent = "НЕТ ДАТЧИКА"; }
}

function onOrientation(event) {
  if (event.alpha == null) return;
  if (app.baseHeading == null) app.baseHeading = event.alpha;
  let delta = event.alpha - app.baseHeading; if (delta > 180) delta -= 360; if (delta < -180) delta += 360;
  engine.yaw = -delta * Math.PI / 180;
}

function updateTrackingUI() {
  els.trackingButton.classList.toggle("active", app.tracking); els.trackingState.textContent = app.tracking ? "ВКЛ" : "ВЫКЛ";
}

els.playButton.addEventListener("click", togglePlayback);
els.prevButton.addEventListener("click", () => selectTrack(app.trackIndex - 1, true));
els.nextButton.addEventListener("click", () => selectTrack(app.trackIndex + 1, true));
document.querySelectorAll("[data-scene]").forEach((button) => button.addEventListener("click", () => applyScene(button.dataset.scene)));
[els.depth, els.room, els.motion].forEach((input) => input.addEventListener("input", updateControls));
document.querySelectorAll(".stem-chip").forEach((chip) => chip.addEventListener("click", () => {
  const stem = chip.dataset.stem; const enabled = !chip.classList.contains("active");
  chip.classList.toggle("active", enabled); chip.setAttribute("aria-pressed", String(enabled)); engine.setStemEnabled(stem, enabled);
}));
els.spatialToggle.addEventListener("change", () => { engine.spatialEnabled = els.spatialToggle.checked; engine.updateMix(); });
els.headphoneToggle.addEventListener("change", () => { engine.headphoneEnabled = els.headphoneToggle.checked; engine.updateMix(); });
els.trackingButton.addEventListener("click", enableTracking);
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
  setStatus("DEMUCS · ПОДГОТОВКА", true);
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
      setStatus(result.state === "queued" ? "DEMUCS · В ОЧЕРЕДИ" : "DEMUCS · РАЗДЕЛЯЕТ", true);
      if (result.state === "done" || result.state === "error") break;
    }
    if (result.state === "error") throw new Error(result.message);
    setStatus(null);
    TRACKS.push({ ...result.track, cover: TRACKS[app.trackIndex].cover });
    selectTrack(TRACKS.length - 1, true);
  } catch (error) {
    setStatus(null);
    els.audioGate.querySelector("span").textContent = `AI-разбор: ${error.message}`;
    els.audioGate.querySelector("button").textContent = "ЗАКРЫТЬ";
    els.audioGate.dataset.mode = "notice";
    els.audioGate.hidden = false;
  } finally {
    addLabel.classList.remove("processing");
    addLabel.lastChild.textContent = originalLabel;
    els.fileInput.value = "";
  }
});
document.querySelector("#infoButton").addEventListener("click", () => els.dialog.showModal());
document.querySelector("#dialogClose").addEventListener("click", () => els.dialog.close());
document.querySelector("#dialogConfirm").addEventListener("click", () => els.dialog.close());
document.querySelector("#resumeButton").addEventListener("click", async () => {
  if (els.audioGate.dataset.mode === "notice") { els.audioGate.hidden = true; return; }
  await engine.context?.resume(); els.audioGate.hidden = true; engine.play().catch(showAudioGate);
});
els.stageCanvas.addEventListener("pointerdown", (event) => { app.dragging = true; app.lastX = event.clientX; els.stageCanvas.setPointerCapture(event.pointerId); });
els.stageCanvas.addEventListener("pointermove", (event) => {
  if (!app.dragging) return; engine.yaw += (event.clientX - app.lastX) * 0.012; app.lastX = event.clientX;
});
els.stageCanvas.addEventListener("pointerup", () => { app.dragging = false; });
els.stageCanvas.addEventListener("pointercancel", () => { app.dragging = false; });
window.addEventListener("resize", drawStage);
document.addEventListener("visibilitychange", () => { if (!document.hidden && engine.context?.state === "suspended" && engine.playing) showAudioGate(); });

selectTrack(0, false);
applyScene("studio");
updateRange(els.seek);
updatePlaybackUI();
drawSpectrum();
