import { makeFilter } from "./hrtf.js";
import { AIR_HZ, CROSSOVER_HZ, STEM_META, STEM_NAMES, VOICES } from "./presets.js";
import { ZONES } from "./rooms.js";
import { cartesian, clamp, DEG, mod } from "./util.js";

/*
  The spatial signal graph. It is built the same way on the live AudioContext and on an
  OfflineAudioContext for WAV export, so what you download is exactly what you heard.

  stem ─┬─ bypass (2D, loudness-matched A/B)
        ├─ < 140 Hz ─ delay ─ pan ───────────────────────────────┐
        └─ > 140 Hz ─ mid/side ─ 14 voices:                      │
             level ─ [presence] ─ dry/shade/lift ─ HRTF ─ near-ear ILD ─ HRTF bus ─ EQ ─┤
             level ─ send ─ 8 zone gains ─ early-reflection convolvers ─┐               │
                         └─ late bus ─ binaural tail convolver ─────────┴─ wet → HRTF bus
*/

export const PARAMS_PER_VOICE = 10 + ZONES;
export const PARAM_COUNT = VOICES.length * PARAMS_PER_VOICE + 1;

const BEHIND_SHELF = { frequency: 3200, gain: -10 };
const ABOVE_PEAK = { frequency: 7800, q: 1.2, gain: 7 };
const MARSHALL_EQ = [["lowshelf", 105, 0.7, -1.7], ["peaking", 260, 0.86, -1.4], ["peaking", 2450, 1, 1.9], ["peaking", 6100, 1.25, -1.15], ["highshelf", 9400, 0.7, 0.85]];

/*
  Turns a choreography frame into raw parameter values for every voice.
  head: { yaw, pitch } in radians (yaw > 0 = head turned right, pitch > 0 = looking up).
  options: { sceneYaw, cue, roomAmt, roomOn }.
  Optional `viz` receives head-relative positions in metres for the visualisers.
*/
export function computeParams(frame, options, head, out = new Float32Array(PARAM_COUNT), viz = null) {
  const sceneCos = Math.cos(options.sceneYaw); const sceneSin = Math.sin(options.sceneYaw);
  const yawCos = Math.cos(head.yaw); const yawSin = Math.sin(head.yaw);
  const pitchCos = Math.cos(head.pitch); const pitchSin = Math.sin(head.pitch);
  const norm = Math.pow(frame.ref, 0.85);
  out.fill(0);
  VOICES.forEach((voice, i) => {
    const v = frame.voices[voice.id];
    let { x, y, z } = cartesian(v.az, v.el, Math.max(0.3, v.d));
    [x, z] = [x * sceneCos - z * sceneSin, x * sceneSin + z * sceneCos];
    [x, z] = [x * yawCos + z * yawSin, -x * yawSin + z * yawCos];
    [y, z] = [y * pitchCos + z * pitchSin, -y * pitchSin + z * pitchCos];
    const d = Math.hypot(x, y, z);
    const az = Math.atan2(x, -z); const el = Math.asin(clamp(y / d, -1, 1));
    const o = i * PARAMS_PER_VOICE;

    // Direction for the HRTF panner (distance is handled by our own gains).
    out[o] = x / d; out[o + 1] = y / d; out[o + 2] = z / d;
    // Level falls with distance relative to the scene's reference distance.
    out[o + 3] = clamp(v.g * norm * Math.pow(d, -0.85), 0, 2.2);
    // Cue enhancement: behind → darker (pinna shadow), above → more ~8 kHz, far → air absorption.
    const back = Math.max(0, -Math.cos(az)) * Math.cos(el);
    const shade = clamp(options.cue * 0.75 * back ** 1.2 + clamp((d - 4) / 20, 0, 0.35), 0, 0.92);
    const lift = options.cue * clamp(Math.sin(el) * 1.25, -0.45, 0.85);
    out[o + 4] = 1 - shade - lift; out[o + 5] = shade; out[o + 6] = lift;
    // Near field: closer than ~0.75 m the far ear gets much quieter (whisper effect).
    const near = clamp((0.75 - d) / 0.5, 0, 1);
    const lateral = Math.sin(az) * Math.cos(el);
    const farEar = 1 - 0.7 * near * Math.abs(lateral); const nearEar = 1 + 0.3 * near * Math.abs(lateral);
    out[o + 7] = lateral > 0 ? farEar : nearEar; out[o + 8] = lateral > 0 ? nearEar : farEar;
    // Room send, panned between the two nearest reflection zones.
    const roomFactor = STEM_META[voice.stem].room * (voice.band === "air" ? 0.8 : 1);
    out[o + 9] = options.roomOn ? v.g * norm * options.roomAmt * roomFactor : 0;
    const k = mod(az / DEG, 360) / (360 / ZONES);
    const k0 = Math.floor(k) % ZONES; const f = k - Math.floor(k);
    out[o + 10 + k0] = Math.cos(f * Math.PI / 2);
    out[o + 10 + (k0 + 1) % ZONES] = Math.sin(f * Math.PI / 2);
    if (viz) { const p = viz[i]; p.x = x; p.y = y; p.z = z; p.d = d; }
  });
  out[PARAM_COUNT - 1] = clamp(frame.lowPan || 0, -1, 1);
  return out;
}

export class SpatialGraph {
  constructor(ctx, calibration, { meters = false } = {}) {
    this.ctx = ctx;
    this.calibration = calibration;
    const latency = calibration.latency;

    this.hrtfBus = this.gain(1);
    this.lowBus = this.gain(1);
    this.bypassBus = this.gain(1);
    this.spatialSum = this.gain(1);
    this.matchGain = this.gain(1);
    this.spatialSwitch = this.gain(1);
    this.bypassSwitch = this.gain(0);
    this.outBus = this.gain(1);
    this.ambienceGain = this.gain(0);
    this.master = this.gain(0.7);
    this.wetBus = this.gain(1);
    this.zoneBuses = Array.from({ length: ZONES }, () => this.mono(1));
    this.lateBus = this.mono(1);

    // HRTF path → measured inverse EQ so the scene keeps the tonal balance of the original mix.
    this.compensation = calibration.eq.map(([frequency, gain, q]) => makeFilter(ctx, "peaking", frequency, q, gain));
    this.chain([this.hrtfBus, ...this.compensation, this.spatialSum]);
    this.wetBus.connect(this.hrtfBus);

    // Lows: one Linkwitz-Riley crossover, delayed by the HRTF latency so everything stays phase-aligned.
    const lowDelay = ctx.createDelay(0.1); lowDelay.delayTime.value = latency;
    this.lowPan = ctx.createStereoPanner();
    this.chain([this.lowBus, makeFilter(ctx, "lowpass", CROSSOVER_HZ, Math.SQRT1_2), makeFilter(ctx, "lowpass", CROSSOVER_HZ, Math.SQRT1_2), lowDelay, this.lowPan, this.spatialSum]);

    const bypassDelay = ctx.createDelay(0.1); bypassDelay.delayTime.value = latency;
    this.chain([this.bypassBus, bypassDelay, this.bypassSwitch, this.outBus]);
    this.chain([this.spatialSum, this.matchGain, this.spatialSwitch, this.outBus]);
    this.ambienceGain.connect(this.outBus);

    if (meters) {
      // K-weighted loudness meters keep 3D and 2D at the same perceived level for a fair A/B.
      const silent = this.gain(0); silent.connect(ctx.destination);
      this.meters = { spatial: this.meter(this.spatialSum, silent), bypass: this.meter(this.bypassBus, silent) };
    }

    this.bassShelf = makeFilter(ctx, "lowshelf", 90, 0.7, 0);
    this.eqFilters = MARSHALL_EQ.map(([type, frequency, q, gain]) => makeFilter(ctx, type, frequency, q, gain));
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.12;
    const tailNodes = [this.outBus, this.bassShelf, ...this.eqFilters, this.master, this.limiter];
    if (meters) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512; this.analyser.smoothingTimeConstant = 0.83;
      tailNodes.push(this.analyser);
    }
    this.chain([...tailNodes, ctx.destination]);

    this.voices = VOICES.map((voice) => ({ ...voice }));
    this.stems = {};
    STEM_NAMES.forEach((stem) => this.createStem(stem));
    this.params = [...this.voices.flatMap((voice) => voice.params), this.lowPan.pan];
    this.lastValues = new Float32Array(this.params.length).fill(NaN);
    this.lastTimes = new Float64Array(this.params.length);
    this.room = null;
    this.ambience = null;
  }

  gain(value) { const node = this.ctx.createGain(); node.gain.value = value; return node; }

  mono(value = 1) {
    const node = this.gain(value);
    node.channelCount = 1; node.channelCountMode = "explicit"; node.channelInterpretation = "speakers";
    return node;
  }

  chain(nodes) { nodes.reduce((previous, node) => { previous.connect(node); return node; }); }

  meter(node, sink) {
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    this.chain([node, makeFilter(this.ctx, "highpass", 120, 0.5), makeFilter(this.ctx, "highshelf", 1700, 0.7, 4), analyser, sink]);
    return { analyser, data: new Float32Array(analyser.fftSize) };
  }

  createStem(stem) {
    const ctx = this.ctx;
    const input = this.gain(1);
    const stemGain = this.gain(1);
    input.connect(stemGain);
    stemGain.connect(this.bypassBus);
    stemGain.connect(this.lowBus);
    const highs = makeFilter(ctx, "highpass", CROSSOVER_HZ, Math.SQRT1_2);
    const highs2 = makeFilter(ctx, "highpass", CROSSOVER_HZ, Math.SQRT1_2);
    stemGain.connect(highs); highs.connect(highs2);
    const bands = { main: highs2 };
    if (stem === "drums") {
      const body = makeFilter(ctx, "lowpass", AIR_HZ, Math.SQRT1_2); const body2 = makeFilter(ctx, "lowpass", AIR_HZ, Math.SQRT1_2);
      const air = makeFilter(ctx, "highpass", AIR_HZ, Math.SQRT1_2); const air2 = makeFilter(ctx, "highpass", AIR_HZ, Math.SQRT1_2);
      this.chain([highs2, body, body2]); this.chain([highs2, air, air2]);
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

    this.voices.filter((voice) => voice.stem === stem).forEach((voice) => {
      const level = this.mono(1);
      parts[voice.band][voice.part].connect(level);
      const presence = voice.part === "mid" ? this.calibration.presence.map(([frequency, gain, q]) => makeFilter(ctx, "peaking", frequency, q, gain)) : [];
      const toned = presence.length ? (this.chain([level, ...presence]), presence[presence.length - 1]) : level;

      // Spectral cues are cross-faded with fixed filters: automating gains is cheap and click-free.
      const dry = this.mono(1); const shadeGain = this.mono(0); const liftGain = this.mono(0); const sum = this.mono(1);
      const shade = makeFilter(ctx, "highshelf", BEHIND_SHELF.frequency, 0.7, BEHIND_SHELF.gain);
      const lift = makeFilter(ctx, "peaking", ABOVE_PEAK.frequency, ABOVE_PEAK.q, ABOVE_PEAK.gain);
      toned.connect(dry); dry.connect(sum);
      this.chain([toned, shade, shadeGain, sum]);
      this.chain([toned, lift, liftGain, sum]);

      const panner = ctx.createPanner();
      panner.panningModel = "HRTF"; panner.distanceModel = "inverse"; panner.rolloffFactor = 0;
      panner.channelCount = 1; panner.channelCountMode = "explicit";
      sum.connect(panner);
      const split = ctx.createChannelSplitter(2); panner.connect(split);
      const earL = this.mono(1); const earR = this.mono(1);
      split.connect(earL, 0); split.connect(earR, 1);
      const merge = ctx.createChannelMerger(2);
      earL.connect(merge, 0, 0); earR.connect(merge, 0, 1);
      merge.connect(this.hrtfBus);

      const send = this.mono(0);
      level.connect(send); send.connect(this.lateBus);
      const zones = this.zoneBuses.map((bus) => { const g = this.mono(0); send.connect(g); g.connect(bus); return g; });
      voice.params = [panner.positionX, panner.positionY, panner.positionZ, level.gain, dry.gain, shadeGain.gain, liftGain.gain,
        earL.gain, earR.gain, send.gain, ...zones.map((zone) => zone.gain)];
    });

    this.stems[stem] = { input, stemGain };
  }

  // Live: short linear ramps written slightly ahead on the audio clock. Unchanged values are skipped;
  // when a parameter resumes moving it is first re-anchored so the ramp does not start in the past.
  ramp(values, at, step) {
    for (let j = 0; j < values.length; j += 1) {
      const value = values[j]; const last = this.lastValues[j];
      if (Math.abs(value - last) < 1e-5) continue;
      const param = this.params[j];
      if (Number.isNaN(last)) param.setValueAtTime(value, at);
      else {
        if (at - this.lastTimes[j] > step * 1.5) param.setValueAtTime(last, at - step);
        param.linearRampToValueAtTime(value, at);
      }
      this.lastValues[j] = value; this.lastTimes[j] = at;
    }
  }

  setNow(values) {
    values.forEach((value, j) => { this.params[j].value = value; this.lastValues[j] = value; });
  }

  // Export: one value curve per parameter for the whole song.
  setCurves(curves, duration) {
    curves.forEach((curve, j) => this.params[j].setValueCurveAtTime(curve, 0, duration));
  }

  setParam(param, value, timeConstant) {
    if (timeConstant <= 0) { param.cancelScheduledValues(0); param.value = value; return; }
    param.setTargetAtTime(value, this.ctx.currentTime, timeConstant);
  }

  setMix({ spatial, headphone, bass }, timeConstant = 0.03) {
    this.setParam(this.spatialSwitch.gain, spatial ? 1 : 0, timeConstant);
    this.setParam(this.bypassSwitch.gain, spatial ? 0 : 1, timeConstant);
    this.eqFilters.forEach((filter, i) => this.setParam(filter.gain, headphone ? MARSHALL_EQ[i][3] : 0, timeConstant));
    this.setParam(this.master.gain, headphone ? 0.66 : 0.74, timeConstant);
    this.setParam(this.bassShelf.gain, bass, timeConstant);
  }

  setRoom(data, fade = 0.3) {
    const ctx = this.ctx;
    const old = this.room;
    this.room = null;
    if (data) {
      const wet = data.room.wet ?? 1;
      const out = this.gain(fade > 0 ? 0 : wet);
      const zoneConvolvers = data.zones.map((buffer, k) => {
        const convolver = ctx.createConvolver(); convolver.normalize = false; convolver.buffer = buffer;
        this.zoneBuses[k].connect(convolver); convolver.connect(out);
        return convolver;
      });
      const late = ctx.createConvolver(); late.normalize = false; late.buffer = data.tail;
      this.lateBus.connect(late); late.connect(out);
      out.connect(this.wetBus);
      if (fade > 0) out.gain.setTargetAtTime(wet, ctx.currentTime, fade / 3);
      this.room = { out, zoneConvolvers, late, key: data.key };
    }
    if (old) {
      if (fade > 0) old.out.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
      const release = () => {
        old.zoneConvolvers.forEach((convolver, k) => { try { this.zoneBuses[k].disconnect(convolver); } catch { /* gone */ } convolver.disconnect(); });
        try { this.lateBus.disconnect(old.late); } catch { /* gone */ }
        old.late.disconnect(); old.out.disconnect();
      };
      if (fade > 0) setTimeout(release, fade * 4000); else release();
    }
  }

  // Ambience loop: cross-faded in and out; `level` follows play/pause.
  setAmbience(buffer, fade = 0.8) {
    const ctx = this.ctx;
    const old = this.ambience;
    this.ambience = null;
    if (buffer) {
      const source = ctx.createBufferSource(); source.buffer = buffer; source.loop = true;
      const gain = this.gain(fade > 0 ? 0 : 1);
      source.connect(gain); gain.connect(this.ambienceGain);
      source.start(ctx.currentTime, Math.random() * buffer.duration);
      if (fade > 0) gain.gain.setTargetAtTime(1, ctx.currentTime, fade / 3);
      this.ambience = { source, gain };
    }
    if (old) {
      if (fade > 0) {
        old.gain.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
        old.source.stop(ctx.currentTime + fade * 3);
        setTimeout(() => old.gain.disconnect(), fade * 3500);
      } else { old.source.stop(); old.gain.disconnect(); }
    }
  }
}
