import { STEM_NAMES } from "./presets.js";
import { clamp, yieldToUI } from "./util.js";

/* Offline beat & energy analysis: tempo, beat grid, downbeats, 8-bar phrases and section intensity. */

export const FPS = 100;

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

export function monoChannel(buffer) {
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
    const result = new Float32Array(frames);
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
      result[f] = end > start ? sum / (end - start) : 0;
    }
    return result;
  });
}

function onsetStrength(bandEnergy) {
  const onset = new Float32Array(bandEnergy.length);
  const log = bandEnergy.map((value) => Math.log10(1e-9 + value));
  for (let f = 2; f < bandEnergy.length; f += 1) onset[f] = Math.max(0, log[f] - Math.max(log[f - 1], log[f - 2]) * 0.5 - log[f - 2] * 0.5);
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

export async function analyzeTrack(buffers) {
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

export function sampleEnvelope(arr, time) {
  if (!arr || !arr.length) return 0;
  const position = time * FPS;
  const index = Math.floor(position);
  if (index < 0) return arr[0] || 0;
  if (index >= arr.length - 1) return arr[arr.length - 1] || 0;
  return arr[index] + (arr[index + 1] - arr[index]) * (position - index);
}

export function beatIndexAt(analysis, time) {
  const beats = analysis?.beats;
  if (!beats || beats.length < 2) return time * 2;
  if (time <= beats[0]) return (time - beats[0]) / analysis.beatPeriod;
  const last = beats.length - 1;
  if (time >= beats[last]) return last + (time - beats[last]) / analysis.beatPeriod;
  let lo = 0; let hi = last;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (beats[mid] <= time) lo = mid; else hi = mid; }
  return lo + (time - beats[lo]) / (beats[lo + 1] - beats[lo]);
}
