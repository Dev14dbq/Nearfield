import { beatIndexAt, sampleEnvelope } from "./analysis.js";
import { clamp, easeInOut, lerp, mod, TAU } from "./util.js";

/*
  Every mode returns, for song time t, the position of each of the 14 voices in the scene:
  az (deg, + = right), el (deg, + = up), d (metres) and g (gain), plus `ref` — the distance that
  plays at unity gain — and `lowPan` for the sub-140 Hz band, which never goes through HRTF.
*/

const V = (az, el, d, g = 1) => ({ az, el, d, g });

function musical(t, analysis) {
  if (!analysis) return { bi: t * 2, phrase: mod(t * 2, 32), long: mod(t * 2, 64), I: 0.6, kick: 0, snare: 0, vox: 0 };
  const bi = beatIndexAt(analysis, t);
  return {
    bi,
    phrase: mod(bi - analysis.phrase, 32),
    long: mod(bi - analysis.phrase, 64),
    I: sampleEnvelope(analysis.intensity, t),
    kick: sampleEnvelope(analysis.kick, t),
    snare: sampleEnvelope(analysis.snare, t),
    vox: sampleEnvelope(analysis.env.vocals, t),
  };
}

function stage(t, m, s) {
  const D = s.distance; const W = s.width; const mo = s.motion;
  const sway = mo * 4 * Math.sin(TAU * t / 7.3);
  const breathe = mo * 2.5 * Math.sin(TAU * t / 11.1 + 1);
  const hatSwing = mo * 5 * Math.sin(Math.PI * m.bi);
  const backing = (13 + 5 * m.I) * W;
  return {
    ref: D,
    voices: {
      "vox-mid": V(sway * 0.5, 3, D),
      "vox-l": V(-backing + sway, 6, D * 1.06),
      "vox-r": V(backing + sway, 6, D * 1.06),
      "bass-mid": V(-7 * W + breathe, -5, D * 1.05),
      "bass-l": V(-24 * W, -4, D * 1.07),
      "bass-r": V(24 * W, -4, D * 1.07),
      "kit-mid": V(4 * W, 1 + 4 * m.snare * mo, D * 1.2),
      "kit-l": V(-32 * W, 4, D * 1.22),
      "kit-r": V(32 * W, 4, D * 1.22),
      "hat-l": V(-24 * W + hatSwing, 12, D * 1.18),
      "hat-r": V(24 * W + hatSwing, 12, D * 1.18),
      "mus-mid": V(9 * W - breathe, 1, D * 1.1),
      "mus-l": V(-50 * W, 4, D * 1.14),
      "mus-r": V(50 * W, 4, D * 1.14),
    },
  };
}

function inside(t, m, s) {
  const D = s.distance; const W = s.width; const mo = s.motion;
  const wide = (deg) => clamp(deg * W, 0, 175);
  const slow = TAU * m.bi / 64;
  const drift = mo * 12 * Math.sin(slow);
  const drift2 = mo * 10 * Math.sin(slow * 0.5 + 1.3);
  const hatSwing = mo * 14 * Math.sin(Math.PI * m.bi);
  return {
    ref: D,
    voices: {
      "vox-mid": V(0, 4, D * 0.92),
      "vox-l": V(-wide(72) + drift, 16, D * 1.08),
      "vox-r": V(wide(72) + drift, 16, D * 1.08),
      "bass-mid": V(0, -16, D * 0.85),
      "bass-l": V(-wide(42), -10, D * 0.92),
      "bass-r": V(wide(42), -10, D * 0.92),
      "kit-mid": V(0, -2, D * 1.28),
      "kit-l": V(-wide(112) - drift2, 4, D * 1.18),
      "kit-r": V(wide(112) + drift2, 4, D * 1.18),
      "hat-l": V(-wide(142) + hatSwing, 30, D * 1.1),
      "hat-r": V(wide(142) + hatSwing, 30, D * 1.1),
      "mus-mid": V(180 + drift, 10, D * 1.35),
      "mus-l": V(-wide(96) + drift2, 6, D * 1.25),
      "mus-r": V(wide(96) + drift2, 6, D * 1.25),
    },
  };
}

// Beat-locked choreography: hats swing like a pendulum and fly around your head before every
// 8-bar phrase, the snare jumps up, music breathes back on the kick, and every 16 bars the
// backing vocals come right up to your ears for a whisper.
function pulse(t, m, s) {
  const mo = s.motion; const D = s.distance;
  const width = s.width * (0.86 + 0.24 * m.I);
  const wide = (deg) => clamp(deg * width, 0, 150);
  const fill = mo >= 0.35 && m.phrase >= 30 ? easeInOut((m.phrase - 30) / 2) * 360 : 0;
  const hatSwing = mo * 52 * Math.sin(Math.PI * m.bi);
  const musicSway = mo * 30 * Math.sin(TAU * m.bi / 32);
  const backingSway = mo * 20 * Math.sin(TAU * m.bi / 16);
  const hit = Math.max(m.kick, m.snare);
  const pump = 1 - 0.2 * m.kick * mo;
  const whisper = mo >= 0.4 && m.long >= 56 ? Math.sin(Math.PI * (m.long - 56) / 8) ** 2 : 0;
  const ear = (side) => (voice) => ({
    az: lerp(voice.az, side * 86, whisper), el: lerp(voice.el, 0, whisper),
    d: Math.exp(lerp(Math.log(voice.d), Math.log(0.38), whisper)), g: voice.g,
  });
  return {
    ref: D,
    voices: {
      "vox-mid": V(0, 4, D * (1 - 0.12 * m.vox * mo)),
      "vox-l": ear(-1)(V(-wide(64 + 16 * m.I) + backingSway, 12, D * 1.15)),
      "vox-r": ear(1)(V(wide(64 + 16 * m.I) + backingSway, 12, D * 1.15)),
      "bass-mid": V(0, -12, D * 0.95),
      "bass-l": V(-wide(34), -8, D),
      "bass-r": V(wide(34), -8, D),
      "kit-mid": V(0, 2 + 16 * m.snare * mo, D * (1.08 - 0.1 * m.kick * mo)),
      "kit-l": V(-wide(46 + 26 * hit * mo), 6, D * 1.18),
      "kit-r": V(wide(46 + 26 * hit * mo), 6, D * 1.18),
      "hat-l": V(hatSwing + fill - wide(36), 22, D * 1.05),
      "hat-r": V(hatSwing + fill + wide(36), 22, D * 1.05),
      "mus-mid": V(mo * 14 * Math.sin(TAU * m.bi / 8), 0, D * (1.32 + 0.18 * m.kick * mo), pump),
      "mus-l": V(-wide(88) + musicSway, 6 + 8 * mo * Math.sin(TAU * m.bi / 16), D * (1.4 + 0.3 * m.kick * mo), pump),
      "mus-r": V(wide(88) + musicSway, 6 - 8 * mo * Math.sin(TAU * m.bi / 16), D * (1.4 + 0.3 * m.kick * mo), pump),
    },
  };
}

// Classic "8D": the whole mix circles your head, one turn every N bars, locked to the beat.
function orbit(t, m, s) {
  const D = s.distance; const W = s.width; const mo = s.motion;
  const beatsPerTurn = 4 * s.orbitBars;
  const turn = m.bi / beatsPerTurn;
  const theta = 360 * turn;
  const wob = mo * 14 * Math.sin(TAU * turn * 2);
  const breath = 1 + mo * 0.18 * Math.sin(TAU * turn * 3);
  const at = (offset, el, dk) => V(theta + offset * W, el + wob, D * dk * breath);
  return {
    ref: D,
    lowPan: Math.sin(theta * Math.PI / 180) * (0.25 + 0.35 * mo),
    voices: {
      "vox-mid": at(0, 4, 1),
      "vox-l": at(-28, 8, 1.05),
      "vox-r": at(28, 8, 1.05),
      "bass-mid": at(0, -8, 0.95),
      "bass-l": at(-30, -6, 1),
      "bass-r": at(30, -6, 1),
      "kit-mid": at(0, 2, 1.05),
      "kit-l": at(-36, 4, 1.1),
      "kit-r": at(36, 4, 1.1),
      "hat-l": at(-44, 14, 1.05),
      "hat-r": at(44, 14, 1.05),
      "mus-mid": at(0, 0, 1.1),
      "mus-l": at(-55, 4, 1.15),
      "mus-r": at(55, 4, 1.15),
    },
  };
}

// Vortex: the lead vocal anchors the front while every other layer spins at its own speed and direction.
function vortex(t, m, s) {
  const D = s.distance; const W = s.width; const mo = s.motion;
  const beats = 4 * s.orbitBars;
  const music = 360 * m.bi / (beats * 2);
  const backing = -360 * m.bi / beats;
  const kit = 360 * m.bi / beats;
  const hats = 360 * m.bi / Math.max(4, beats / 4);
  const helix = 28 * Math.sin(TAU * m.bi / 8) * (0.4 + 0.6 * mo);
  return {
    ref: D,
    lowPan: 0.3 * mo * Math.sin(kit * Math.PI / 180),
    voices: {
      "vox-mid": V(mo * 10 * Math.sin(TAU * m.bi / 16), 4, D * 0.92),
      "vox-l": V(backing, 14, D * 1.08),
      "vox-r": V(backing + 180, 14, D * 1.08),
      "bass-mid": V(0, -14, D * 0.85),
      "bass-l": V(-40 * W, -10, D * 0.92),
      "bass-r": V(40 * W, -10, D * 0.92),
      "kit-mid": V(0, -2, D * 1.2),
      "kit-l": V(kit + 90, 6, D * 1.15),
      "kit-r": V(kit - 90, 6, D * 1.15),
      "hat-l": V(hats, 20 + helix, D),
      "hat-r": V(hats + 180, 20 - helix, D),
      "mus-mid": V(180 + music, 8, D * 1.3),
      "mus-l": V(music - 90 * W, 4, D * 1.2),
      "mus-r": V(music + 90 * W, 4, D * 1.2),
    },
  };
}

// Dream: slow Lissajous drifts in all three dimensions, not tied to the beat.
const DRIFT = {
  "vox-l": [-70, 22, 1.1], "vox-r": [70, 22, 1.1],
  "bass-mid": [0, -14, 0.9], "bass-l": [-50, -6, 1], "bass-r": [50, -6, 1],
  "kit-mid": [0, 0, 1.3], "kit-l": [-115, 8, 1.25], "kit-r": [115, 8, 1.25],
  "hat-l": [-140, 40, 1.15], "hat-r": [140, 40, 1.15],
  "mus-mid": [180, 18, 1.5], "mus-l": [-100, 12, 1.4], "mus-r": [100, 12, 1.4],
};
const DRIFT_IDS = Object.keys(DRIFT);

function dream(t, m, s) {
  const D = s.distance; const W = s.width; const mo = s.motion;
  const u = t * (0.02 + 0.05 * mo);
  const voices = {
    "vox-mid": V(14 * mo * Math.sin(TAU * u * 0.6), 8 + 5 * Math.sin(TAU * u * 0.4 + 1), D * (0.9 + 0.08 * Math.sin(TAU * u * 0.5))),
  };
  DRIFT_IDS.forEach((id, i) => {
    const [az, el, dk] = DRIFT[id];
    const phase = i * 1.7;
    voices[id] = V(
      clamp(az * W, -175, 175) + 55 * mo * Math.sin(TAU * u * (0.7 + 0.13 * i) + phase),
      el + 18 * Math.sin(TAU * u * (0.5 + 0.11 * i) + phase * 0.7),
      D * dk * (1 + 0.25 * Math.sin(TAU * u * (0.45 + 0.07 * i) + phase * 1.3)),
    );
  });
  return { ref: D, voices };
}

const SPREAD = { vocals: 22, bass: 26, drums: 30, other: 48 };

function custom(t, m, s) {
  const D = s.distance; const W = s.width; const mo = s.motion;
  const sway = mo * 4 * Math.sin(TAU * t / 9.1);
  const pos = (stem) => s.custom?.[stem] || { az: 0, el: 0, r: 1 };
  const pair = (stem, idMid, idL, idR, elOffset = 0) => {
    const p = pos(stem); const spread = SPREAD[stem] * W;
    return {
      [idMid]: V(p.az + sway, p.el + elOffset, D * p.r),
      [idL]: V(p.az - spread + sway, p.el + 4 + elOffset, D * p.r * 1.05),
      [idR]: V(p.az + spread + sway, p.el + 4 + elOffset, D * p.r * 1.05),
    };
  };
  const drums = pos("drums");
  return {
    ref: D,
    voices: {
      ...pair("vocals", "vox-mid", "vox-l", "vox-r"),
      ...pair("bass", "bass-mid", "bass-l", "bass-r"),
      ...pair("drums", "kit-mid", "kit-l", "kit-r"),
      ...pair("other", "mus-mid", "mus-l", "mus-r"),
      "hat-l": V(drums.az - 30 * W + mo * 6 * Math.sin(Math.PI * m.bi), drums.el + 14, D * drums.r),
      "hat-r": V(drums.az + 30 * W + mo * 6 * Math.sin(Math.PI * m.bi), drums.el + 14, D * drums.r),
    },
  };
}

const MODE_FUNCTIONS = { stage, inside, pulse, orbit, vortex, dream, custom };

export function choreograph(mode, t, analysis, settings) {
  const fn = MODE_FUNCTIONS[mode] || inside;
  const frame = fn(t, musical(t, analysis), settings);
  frame.lowPan ??= 0;
  return frame;
}

// Smooth hand-over between two frames: shortest-way azimuth, log distance.
export function blendFrames(a, b, k) {
  if (k >= 1) return b;
  if (k <= 0) return a;
  const voices = {};
  Object.keys(b.voices).forEach((id) => {
    const p = a.voices[id]; const q = b.voices[id];
    const daz = mod(q.az - p.az + 180, 360) - 180;
    voices[id] = {
      az: p.az + daz * k, el: lerp(p.el, q.el, k),
      d: Math.exp(lerp(Math.log(p.d), Math.log(q.d), k)), g: lerp(p.g, q.g, k),
    };
  });
  return { ref: lerp(a.ref, b.ref, k), lowPan: lerp(a.lowPan, b.lowPan, k), voices };
}
