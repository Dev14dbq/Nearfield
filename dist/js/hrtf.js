import { cartesian, clamp, energy, renderOffline } from "./util.js";

/*
  Everything here measures the browser's own HRTF set (the one PannerNode uses), so that rooms,
  ambiences and EQ built from it line up perfectly with the live sources.
*/

export function makeFilter(ctx, type, frequency, q, gain = 0) {
  const node = ctx.createBiquadFilter();
  // Web Audio reads lowpass/highpass Q in dB, peaking/bandpass/shelf Q linearly; callers always pass linear Q.
  const resonanceInDb = type === "lowpass" || type === "highpass";
  node.type = type; node.frequency.value = frequency;
  node.Q.value = resonanceInDb ? 20 * Math.log10(q) : q;
  node.gain.value = gain;
  return node;
}

function placePanner(panner, az, el) {
  const { x, y, z } = cartesian(az, el, 1);
  panner.positionX.value = x; panner.positionY.value = y; panner.positionZ.value = z;
}

// Renders a unit impulse through an HRTF panner for every direction, spaced `window` samples apart.
async function impulseResponses(sampleRate, directions, window) {
  const rendered = await renderOffline(2, window * directions.length, sampleRate, (offline) => {
    const impulse = offline.createBuffer(1, 1, sampleRate);
    impulse.getChannelData(0)[0] = 1;
    directions.forEach(([az, el], i) => {
      const source = offline.createBufferSource(); source.buffer = impulse;
      const panner = offline.createPanner();
      panner.panningModel = "HRTF"; panner.rolloffFactor = 0;
      placePanner(panner, az, el);
      source.connect(panner); panner.connect(offline.destination);
      source.start(i * window / sampleRate);
    });
  }, (buffer) => directions.every((_, i) => energy(buffer.getChannelData(0), i * window, (i + 1) * window) + energy(buffer.getChannelData(1), i * window, (i + 1) * window) > 1e-6));
  return directions.map((_, i) => [
    rendered.getChannelData(0).slice(i * window, (i + 1) * window),
    rendered.getChannelData(1).slice(i * window, (i + 1) * window),
  ]);
}

// Measures latency and tonal colouring of the HRTF set in front of the listener and fits
// inverse EQ curves so that the 3D scene keeps the tonal balance of the original mix.
export async function calibrate(sampleRate) {
  const fitContext = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 128, sampleRate);
  // Weighted like the actual layout: centre voices up front, kit and hats at ±20–45°, wide music and doubles at ±70–90°.
  const responses = [[0, 4], [-20, 1], [20, 1], [-45, 1], [45, 1], [-70, 0.8], [70, 0.8], [-90, 0.8], [90, 0.8]];
  const irs = await impulseResponses(sampleRate, responses.map(([az]) => [az, 0]), 8192);
  const [frontL, frontR] = irs[0];
  let peak = 0; let peakIndex = 0;
  for (let i = 0; i < frontL.length; i += 1) {
    const value = Math.abs(frontL[i]) + Math.abs(frontR[i]);
    if (value > peak) { peak = value; peakIndex = i; }
  }

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
    const filters = centers.map((frequency) => makeFilter(fitContext, "peaking", frequency, q, 0));
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
  return { latency: peakIndex / sampleRate, eq: global.bands, presence: presence.bands, frontEnergy: energy(frontL) + energy(frontR) };
}

// A grid of measured HRIRs (55 directions) used to render reflections in JavaScript.
export async function measureGrid(sampleRate) {
  const directions = [];
  for (let az = 0; az < 360; az += 15) directions.push([az, 0]);
  for (const el of [-30, 30]) for (let az = 0; az < 360; az += 30) directions.push([az, el]);
  for (let az = 0; az < 360; az += 60) directions.push([az, 60]);
  directions.push([0, 90]);
  const length = 640;
  const irs = await impulseResponses(sampleRate, directions, 1024);
  return {
    sampleRate, length,
    vectors: directions.map(([az, el]) => cartesian(az, el, 1)),
    left: irs.map(([l]) => l.slice(0, length)),
    right: irs.map(([, r]) => r.slice(0, length)),
    nearest({ x, y, z }) {
      let best = 0; let bestDot = -Infinity;
      const n = Math.hypot(x, y, z) || 1;
      this.vectors.forEach((v, i) => {
        const dot = (v.x * x + v.y * y + v.z * z) / n;
        if (dot > bestDot) { bestDot = dot; best = i; }
      });
      return best;
    },
  };
}
