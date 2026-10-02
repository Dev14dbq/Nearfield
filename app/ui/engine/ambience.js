import { cartesian, renderOffline, seededRandom, TAU } from "./util.js";

/*
  Procedural ambiences, rendered once into a seamless binaural loop. Every emitter is a mono
  signal that is periodic over the loop length; it is rendered twice in a row through the HRTF
  and the second pass is kept, so the loop point is inaudible.
*/

const TARGET_RMS = 0.045;

// Runs a stateful filter over the signal twice and keeps the second pass (steady, periodic state).
function cyclic(signal, makeStep) {
  const step = makeStep();
  for (let i = 0; i < signal.length; i += 1) step(signal[i]);
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i += 1) out[i] = step(signal[i]);
  return out;
}

const onePoleLow = (fc, sr) => () => { const a = 1 - Math.exp(-TAU * fc / sr); let y = 0; return (x) => { y += a * (x - y); return y; }; };
const onePoleHigh = (fc, sr) => () => { const a = 1 - Math.exp(-TAU * fc / sr); let y = 0; return (x) => { y += a * (x - y); return x - y; }; };
const brown = () => () => { let y = 0; return (x) => { y = y * 0.997 + x * 0.06; return y; }; };

function noise(length, rand) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = rand() * 2 - 1;
  return out;
}

// Periodic smooth random envelope: a sum of sines whose periods divide the loop.
function swell(length, sr, rand, cycles, depth = 1) {
  const out = new Float32Array(length);
  const parts = cycles.map((c) => [c, rand() * TAU, 0.5 + rand() * 0.5]);
  const norm = parts.reduce((s, [, , a]) => s + a, 0);
  for (let i = 0; i < length; i += 1) {
    let v = 0;
    parts.forEach(([c, phase, a]) => { v += a * Math.sin(TAU * c * i / length + phase); });
    out[i] = 1 - depth * 0.5 + depth * 0.5 * (v / norm);
  }
  return out;
}

function addEvent(target, at, render, length) {
  for (let j = 0; j < length; j += 1) target[(at + j) % target.length] += render(j);
}

function scatterDrops(target, sr, rand, rate, freqMin, freqMax, tauMin, tauMax, amp) {
  const count = Math.round(rate * target.length / sr);
  for (let k = 0; k < count; k += 1) {
    const at = Math.floor(rand() * target.length);
    const f = freqMin + (freqMax - freqMin) * rand();
    const tau = (tauMin + (tauMax - tauMin) * rand()) * sr;
    const a = amp * rand() ** 2 * (rand() < 0.5 ? -1 : 1);
    const w = TAU * f / sr;
    addEvent(target, at, (j) => a * Math.sin(w * j) * Math.exp(-j / tau), Math.ceil(tau * 5));
  }
}

function rain(sr, rand) {
  const L = 16 * sr; const emitters = [];
  [-150, -90, -30, 30, 90, 150].forEach((az, i) => {
    let bed = cyclic(noise(L, rand), onePoleHigh(700, sr));
    bed = cyclic(bed, onePoleLow(6000, sr));
    const env = swell(L, sr, rand, [1, 2, 3, 5], 0.35);
    const signal = bed.map((v, j) => v * 0.16 * env[j]);
    scatterDrops(signal, sr, rand, 55, 1800, 6500, 0.0015, 0.005, 0.22);
    scatterDrops(signal, sr, rand, 1.2, 500, 1100, 0.006, 0.012, 0.35);
    emitters.push({ az: az + rand() * 20, el: 35 + rand() * 25, signal });
  });
  // A slow drip from the gutter just outside the window — one clear, localised point in the field.
  const drip = new Float32Array(L);
  const drips = 18;
  for (let k = 0; k < drips; k += 1) {
    const at = Math.floor((k + rand() * 0.4) * L / drips);
    const f = 1100 + rand() * 300; const tau = 0.012 * sr; const w = TAU * f / sr;
    addEvent(drip, at, (j) => 0.35 * Math.sin(w * j * (1 + j / (tau * 8))) * Math.exp(-j / tau), Math.ceil(tau * 6));
  }
  emitters.push({ az: 62, el: -8, signal: drip });
  return { length: L, emitters };
}

function ocean(sr, rand) {
  const L = 24 * sr; const emitters = [];
  [[-55, 1], [0, 1], [55, 1], [-115, 0.5], [115, 0.5]].forEach(([az, level], i) => {
    const body = cyclic(cyclic(noise(L, rand), brown()), onePoleLow(600, sr));
    let foam = cyclic(noise(L, rand), onePoleHigh(1500, sr));
    foam = cyclic(foam, onePoleLow(7000, sr));
    const period = [3, 2, 4, 3, 2][i];
    const phase = rand();
    const signal = new Float32Array(L);
    for (let j = 0; j < L; j += 1) {
      const x = (j / L * period + phase) % 1;
      const s = Math.sin(Math.PI * x) ** 2;
      // The foam breaks just after the swell peaks.
      const y = (x - 0.12) / 0.88;
      const crest = y > 0 ? Math.sin(Math.PI * y) ** 6 : 0;
      signal[j] = level * (body[j] * 0.5 * (0.25 + s) + foam[j] * 0.35 * crest);
    }
    emitters.push({ az, el: -8, signal });
  });
  return { length: L, emitters };
}

function wind(sr, rand) {
  const L = 20 * sr; const emitters = [];
  [-120, -30, 60, 150].forEach((az) => {
    const n = noise(L, rand);
    const low = cyclic(n, onePoleLow(220, sr));
    const high = cyclic(n, onePoleLow(950, sr));
    const gust = swell(L, sr, rand, [1, 2, 3, 4], 0.9);
    const signal = high.map((v, j) => (v - low[j]) * 1.6 * gust[j] ** 2);
    emitters.push({ az, el: 10 + rand() * 25, signal });
  });
  return { length: L, emitters };
}

function fire(sr, rand) {
  const L = 16 * sr; const emitters = [];
  [[22, 1], [34, 0.8]].forEach(([az, level]) => {
    const rumble = cyclic(cyclic(noise(L, rand), brown()), onePoleLow(170, sr));
    const flicker = swell(L, sr, rand, [3, 5, 7, 11, 13], 0.6);
    const signal = rumble.map((v, j) => v * 0.9 * flicker[j] * level);
    const crackles = Math.round(9 * L / sr);
    for (let k = 0; k < crackles; k += 1) {
      const at = Math.floor(rand() * L); const len = Math.ceil((0.001 + rand() * 0.003) * sr);
      const a = 0.5 * rand() ** 3 * level; let prev = 0;
      addEvent(signal, at, (j) => { const x = (rand() * 2 - 1) * Math.exp(-j / (len / 3)); const y = x - prev; prev = x; return a * y; }, len);
    }
    scatterDrops(signal, sr, rand, 0.6, 500, 800, 0.004, 0.008, 0.5 * level);
    emitters.push({ az, el: -22, signal });
  });
  return { length: L, emitters };
}

function night(sr, rand) {
  const L = 20 * sr; const emitters = [];
  [[-120, -6, 0.5], [-40, -10, 0.8], [50, -4, 0.65], [140, -8, 0.4]].forEach(([az, el, level]) => {
    const signal = new Float32Array(L);
    const groups = Math.round(L / sr / (0.55 + rand() * 0.35));
    const f = 4300 + rand() * 900; const w = TAU * f / sr;
    const pulse = Math.round(0.018 * sr); const gap = Math.round(0.03 * sr);
    for (let g = 0; g < groups; g += 1) {
      const start = Math.floor(g * L / groups + rand() * 0.04 * sr);
      const pulses = 3 + Math.floor(rand() * 2);
      for (let p = 0; p < pulses; p += 1) {
        addEvent(signal, start + p * gap, (j) => level * 0.3 * Math.sin(w * j) * Math.sin(Math.PI * j / pulse) ** 2, pulse);
      }
    }
    emitters.push({ az, el, signal });
  });
  const breeze = cyclic(cyclic(noise(L, rand), onePoleLow(380, sr)), onePoleHigh(60, sr));
  const env = swell(L, sr, rand, [1, 2, 3], 0.7);
  emitters.push({ az: 90, el: 20, signal: breeze.map((v, j) => v * 0.35 * env[j]) });
  return { length: L, emitters };
}

// Vinyl lives "inside" the record, not in the room — rendered as plain stereo.
function vinyl(sr, rand) {
  const L = 12 * sr;
  const hissL = cyclic(noise(L, rand), onePoleHigh(2500, sr));
  const hissR = cyclic(noise(L, rand), onePoleHigh(2500, sr));
  const left = hissL.map((v) => v * 0.02); const right = hissR.map((v) => v * 0.02);
  const clicks = Math.round(14 * L / sr);
  for (let k = 0; k < clicks; k += 1) {
    const at = Math.floor(rand() * L); const a = 0.12 * rand() ** 3; const pan = 0.5 + (rand() - 0.5) * 0.4;
    const len = 2 + Math.floor(rand() * 4); let prev = 0;
    const shape = (j) => { const x = (rand() * 2 - 1) * Math.exp(-j / 1.5); const y = x - prev; prev = x; return a * y; };
    for (let j = 0; j < len; j += 1) { const v = shape(j); left[(at + j) % L] += v * (1 - pan); right[(at + j) % L] += v * pan; }
  }
  // Slow rumble at 33⅓ rpm.
  const rpm = 33.333 / 60;
  const turns = Math.round(rpm * L / sr);
  for (let j = 0; j < L; j += 1) {
    const r = 0.006 * Math.sin(TAU * turns * j / L) * Math.sin(TAU * 31 * j / sr);
    left[j] += r; right[j] += r;
  }
  return { length: L, stereo: [left, right] };
}

const GENERATORS = { rain, ocean, wind, fire, night, vinyl };

// RMS normalisation, then a soft ceiling so rare transients (crackles, drops) never poke out.
function normalize(channels, ceiling = 0.32) {
  let sum = 0; let count = 0;
  channels.forEach((data) => { for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i]; count += data.length; });
  const scale = TARGET_RMS / Math.sqrt(sum / count || 1);
  channels.forEach((data) => { for (let i = 0; i < data.length; i += 1) data[i] = ceiling * Math.tanh(data[i] * scale / ceiling); });
}

export async function renderAmbience(id, grid) {
  const sampleRate = grid.sampleRate;
  const generator = GENERATORS[id];
  if (!generator) return null;
  const rand = seededRandom(id.split("").reduce((s, c) => s * 31 + c.charCodeAt(0), 7));
  const spec = generator(sampleRate, rand);
  let left; let right;
  if (spec.stereo) {
    [left, right] = spec.stereo;
  } else {
    const rendered = await renderOffline(2, spec.length * 2, sampleRate, (offline) => {
      spec.emitters.forEach(({ az, el, signal }) => {
        const buffer = offline.createBuffer(1, spec.length, sampleRate);
        buffer.copyToChannel(signal, 0);
        const source = offline.createBufferSource(); source.buffer = buffer; source.loop = true;
        const convolver = offline.createConvolver(); convolver.normalize = false;
        convolver.buffer = grid.buffer(grid.nearest(cartesian(az, el, 1)));
        source.connect(convolver); convolver.connect(offline.destination); source.start();
      });
    }, (buffer) => buffer.getChannelData(0).subarray(spec.length).some((v) => v !== 0));
    left = rendered.getChannelData(0).slice(spec.length);
    right = rendered.getChannelData(1).slice(spec.length);
  }
  normalize([left, right]);
  const buffer = new AudioBuffer({ numberOfChannels: 2, length: spec.length, sampleRate });
  buffer.copyToChannel(left, 0); buffer.copyToChannel(right, 1);
  return buffer;
}
