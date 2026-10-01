import { FPS, monoChannel, sampleEnvelope } from "./analysis.js";
import { clamp } from "./util.js";

/*
  Automatic style detection from the separated stems. No neural network: a handful of robust
  musical features (how much of the energy is drums / bass / vocals, how fast the vocal syllables
  come, how machine-tight the beat is, how much the music ducks under the kick, dynamics,
  how bright/distorted the instruments are), scored against simple style profiles.
  Each style maps to a scene that suits it; the user can always override.
*/

export const STYLES = [
  {
    id: "pop", label: "Поп", hint: "вокал впереди, инструменты вокруг",
    settings: { mode: "inside", room: "studio", width: 1.1, distance: 1.6, motion: 0.45, roomAmt: 1.1, cue: 0.65, bass: 2 },
  },
  {
    id: "rap", label: "Рэп", hint: "голос в упор, бит качает",
    settings: { mode: "pulse", room: "studio", width: 1, distance: 1.4, motion: 0.35, roomAmt: 0.7, cue: 0.6, bass: 5 },
  },
  {
    id: "electronic", label: "Электро", hint: "всё движется под бит",
    settings: { mode: "pulse", room: "club", width: 1.2, distance: 1.8, motion: 0.8, roomAmt: 0.9, cue: 0.7, bass: 5 },
  },
  {
    id: "rock", label: "Рок", hint: "группа на сцене",
    settings: { mode: "stage", room: "club", width: 1.25, distance: 3.5, motion: 0.25, roomAmt: 1, cue: 0.6, bass: 3 },
  },
  {
    id: "classical", label: "Классика", hint: "оркестр в зале",
    settings: { mode: "stage", room: "hall", width: 1.35, distance: 10, motion: 0.05, roomAmt: 1.15, cue: 0.5, bass: 0 },
  },
  {
    id: "jazz", label: "Джаз", hint: "маленький клуб, живой звук",
    settings: { mode: "stage", room: "club", width: 1.1, distance: 2.6, motion: 0.15, roomAmt: 0.9, cue: 0.55, bass: 1 },
  },
  {
    id: "ambient", label: "Эмбиент", hint: "звук плывёт вокруг",
    settings: { mode: "dream", room: "cathedral", width: 1.3, distance: 2.6, motion: 0.5, roomAmt: 1.2, cue: 0.7, bass: 2 },
  },
];

export const findStyle = (id) => STYLES.find((style) => style.id === id) || STYLES[0];

const ramp = (x, a, b) => clamp((x - a) / (b - a), 0, 1);
const band = (x, lo, hi, soft) => Math.min(ramp(x, lo - soft, lo), 1 - ramp(x, hi, hi + soft));

function frameRms(samples, hop) {
  const frames = Math.floor(samples.length / hop);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop; i += 1) sum += samples[i] * samples[i];
    out[f] = Math.sqrt(sum / hop);
  }
  return out;
}

const quantile = (arr, q) => { const s = Float32Array.from(arr).sort(); return s[Math.floor(q * (s.length - 1))] || 0; };
const mean = (arr) => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);

export function trackFeatures(buffers, analysis) {
  const sampleRate = Object.values(buffers)[0].sampleRate;
  const hop = Math.round(sampleRate / FPS);
  const rms = {}; const power = {};
  ["vocals", "bass", "drums", "other"].forEach((stem) => {
    rms[stem] = buffers[stem] ? frameRms(monoChannel(buffers[stem]), hop) : new Float32Array(1);
    power[stem] = mean(Array.from(rms[stem], (v) => v * v));
  });
  const frames = Math.min(...Object.values(rms).map((r) => r.length));
  const total = Object.values(power).reduce((s, v) => s + v, 0) || 1e-12;
  const share = Object.fromEntries(Object.entries(power).map(([stem, p]) => [stem, p / total]));

  // Vocals are "present" in a frame when the vocal stem is within ~14 dB of the loudest stem.
  const mix = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) mix[f] = Math.max(rms.vocals[f], rms.bass[f], rms.drums[f], rms.other[f]);
  const loud = quantile(mix, 0.6) || 1e-6;
  let voiced = 0; let syllables = 0; let previous = 0;
  for (let f = 1; f < frames; f += 1) {
    const active = rms.vocals[f] > 0.2 * Math.max(mix[f], loud * 0.3) && rms.vocals[f] > loud * 0.06;
    if (active) voiced += 1;
    // Syllables: rises of more than ~4.5 dB in the vocal envelope over 30 ms.
    const level = 20 * Math.log10(rms.vocals[f] + 1e-6);
    const before = 20 * Math.log10((rms.vocals[f - 3] ?? rms.vocals[0]) + 1e-6);
    const onset = active && level - before > 4.5;
    if (onset && f - previous > 8) { syllables += 1; previous = f; }
  }
  const vocalPresence = voiced / Math.max(1, frames);
  const syllableRate = syllables / Math.max(1, voiced / FPS);

  // Beat regularity: spread of beat intervals (programmed beats are near-perfect).
  const intervals = [];
  for (let i = 1; i < analysis.beats.length; i += 1) intervals.push(analysis.beats[i] - analysis.beats[i - 1]);
  const median = quantile(intervals, 0.5) || 0.5;
  const regularity = mean(intervals.map((v) => Math.abs(v - median))) / median;

  // Dynamics: how far quiet passages sit below loud ones (dB).
  const dynamics = 20 * Math.log10((quantile(mix, 0.95) + 1e-6) / (quantile(mix, 0.2) + 1e-6));

  // Pump: how much the music drops right after strong kicks (side-chain compression).
  let ducked = 0; let normal = 0; let hits = 0;
  for (let f = 20; f < frames - 20; f += 1) {
    const kick = sampleEnvelope(analysis.kick, f / FPS);
    if (kick > 0.85 && sampleEnvelope(analysis.kick, (f - 1) / FPS) <= 0.85) {
      ducked += rms.other[f + 8]; normal += 0.5 * (rms.other[f - 6] + rms.other[f + 30]); hits += 1;
    }
  }
  const pump = hits > 8 && normal > 0 ? 1 - ducked / normal : 0;

  // Brightness of the instruments: zero-crossing rate of the "other" stem (distortion, cymbals, synths).
  const other = buffers.other ? monoChannel(buffers.other) : new Float32Array(2);
  let crossings = 0; let counted = 0;
  for (let i = 1; i < other.length; i += 7) { if ((other[i] >= 0) !== (other[i - 1] >= 0)) crossings += 1; counted += 1; }
  const brightness = crossings / Math.max(1, counted) * sampleRate / 2;

  return { bpm: analysis.bpm, share, vocalPresence, syllableRate, regularity, dynamics, pump, brightness };
}

export function classifyStyle(f) {
  const { share, bpm } = f;
  const rhythm = share.drums + share.bass;
  const halfOrDouble = Math.max(band(bpm, 70, 100, 8), band(bpm, 135, 175, 8));
  const scores = {
    pop: 0.45 + 0.25 * ramp(f.vocalPresence, 0.25, 0.5) + 0.15 * band(bpm, 90, 130, 15) - 0.25 * ramp(f.syllableRate, 5, 6.2),
    rap: 0.9 * ramp(f.syllableRate, 4.4, 5.8) * ramp(f.vocalPresence, 0.3, 0.55) + 0.3 * ramp(rhythm, 0.45, 0.7) + 0.15 * halfOrDouble - 0.3 * ramp(share.other, 0.4, 0.6),
    electronic: 0.5 * ramp(0.02 - f.regularity, 0, 0.012) + 0.4 * ramp(f.pump, 0.08, 0.25) + 0.25 * ramp(share.drums, 0.2, 0.4) + 0.15 * band(bpm, 118, 132, 6) - 0.3 * ramp(f.vocalPresence, 0.55, 0.8),
    rock: 0.55 * ramp(f.brightness, 1600, 3200) * ramp(share.other, 0.3, 0.5) + 0.3 * ramp(share.drums, 0.15, 0.3) + 0.2 * ramp(f.regularity, 0.012, 0.03),
    classical: 0.6 * ramp(0.06 - share.drums, 0, 0.05) + 0.35 * ramp(f.dynamics, 14, 26) + 0.2 * ramp(f.regularity, 0.04, 0.12) - 0.3 * ramp(f.vocalPresence, 0.35, 0.6),
    jazz: 0.35 * ramp(f.regularity, 0.015, 0.04) + 0.3 * ramp(share.other, 0.35, 0.55) + 0.25 * ramp(share.bass, 0.12, 0.25) + 0.2 * ramp(1800 - f.brightness, 0, 900) - 0.35 * ramp(f.pump, 0.1, 0.25) - 0.4 * ramp(0.04 - share.drums, 0, 0.03),
    ambient: 0.55 * ramp(0.12 - share.drums, 0, 0.1) + 0.35 * ramp(share.other, 0.5, 0.75) + 0.2 * ramp(12 - f.dynamics, 0, 6) - 0.2 * ramp(f.vocalPresence, 0.35, 0.6),
  };
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, top] = ranked[0];
  const second = ranked[1][1];
  const confidence = clamp(0.5 + (top - second) * 1.5, 0.35, 0.97);
  return { id: best, confidence, scores, vocals: f.vocalPresence > 0.08 };
}
