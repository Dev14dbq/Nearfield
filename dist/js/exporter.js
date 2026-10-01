import { choreograph } from "./choreography.js";
import { computeParams, PARAM_COUNT, SpatialGraph } from "./graph.js";
import { findRoom, STEM_NAMES } from "./presets.js";
import { clamp, yieldToUI } from "./util.js";

/*
  Renders the current scene offline, through exactly the same graph, into a binaural WAV:
  the 3D version can be played on any phone or in any player with ordinary headphones.
  All motion is written as one value curve per parameter (100 points per second).
*/

const CURVE_RATE = 100;

export async function renderBinaural(engine, { maxSeconds = Infinity, onProgress = () => {}, raw = false } = {}) {
  if (!engine.analysis || !Object.keys(engine.buffers).length) throw new Error("Трек ещё не загружен");
  const sampleRate = engine.context.sampleRate;
  const s = JSON.parse(JSON.stringify(engine.settings));
  const rate = engine.rate;
  const room = findRoom(s.room);
  const roomData = room.dims ? await engine.rooms.get(room, s.distance) : null;
  const ambience = s.ambience !== "none" ? await engine.ambienceBuffer(s.ambience) : null;
  const songDuration = Math.min(engine.duration, maxSeconds * rate);
  const playDuration = songDuration / rate;
  const tail = room.dims ? clamp(Math.max(...room.rt) * 0.8, 0.5, 5) : 0.3;
  const total = playDuration + tail;
  const offline = new OfflineAudioContext(2, Math.ceil(total * sampleRate), sampleRate);

  const graph = new SpatialGraph(offline, engine.calibration);
  graph.setMix({ spatial: true, headphone: s.headphone, bass: s.bass }, 0);
  STEM_NAMES.forEach((stem) => { graph.stems[stem].stemGain.gain.value = engine.stemEnabled[stem] ? 1 : 0; });
  if (roomData) graph.setRoom(roomData, 0);
  if (ambience) {
    graph.setAmbience(ambience, 0);
    const level = s.ambienceLevel * 2;
    graph.ambienceGain.gain.setValueAtTime(0, 0);
    graph.ambienceGain.gain.linearRampToValueAtTime(level, 1.5);
    graph.ambienceGain.gain.setValueAtTime(level, Math.max(1.5, playDuration - 1));
    graph.ambienceGain.gain.linearRampToValueAtTime(0, total);
  }

  const frames = Math.ceil(total * CURVE_RATE) + 1;
  const curves = Array.from({ length: PARAM_COUNT }, () => new Float32Array(frames));
  const values = new Float32Array(PARAM_COUNT);
  const options = { sceneYaw: s.sceneYaw, cue: s.cue, roomAmt: s.roomAmt, roomOn: Boolean(roomData) };
  const head = { yaw: 0, pitch: 0 };
  for (let k = 0; k < frames; k += 1) {
    const songT = Math.min(songDuration, k / CURVE_RATE * rate);
    computeParams(choreograph(s.mode, songT, engine.analysis, s), options, head, values);
    for (let j = 0; j < PARAM_COUNT; j += 1) curves[j][k] = values[j];
    if (k % 3000 === 0) { onProgress(0.08 * k / frames); await yieldToUI(); }
  }
  graph.setCurves(curves, (frames - 1) / CURVE_RATE);

  Object.entries(engine.buffers).forEach(([stem, buffer]) => {
    const source = offline.createBufferSource();
    source.buffer = buffer; source.playbackRate.value = rate;
    source.connect(graph.stems[stem].input);
    source.start(0, 0, songDuration);
  });

  const marks = 24;
  for (let i = 1; i < marks; i += 1) {
    offline.suspend(total * i / marks).then(() => { onProgress(0.08 + 0.88 * i / marks); offline.resume(); });
  }
  const rendered = await offline.startRendering();
  onProgress(0.97);
  await yieldToUI();
  if (raw) return rendered;
  // Same loudness as the original mix (like the live A/B), then a true brickwall at −0.3 dBFS.
  const original = weightedPower(Object.values(engine.buffers), Math.round(songDuration * sampleRate));
  const spatial = weightedPower([rendered], Math.round(playDuration * sampleRate));
  limit(rendered, clamp(Math.sqrt(original / Math.max(spatial, 1e-12)), 0.3, 4));
  return rendered;
}

// Mean power after a 120 Hz high-pass (bass dominates plain RMS but not perceived loudness).
function weightedPower(buffers, frames) {
  let sum = 0; let count = 0;
  const channels = Math.max(...buffers.map((buffer) => buffer.numberOfChannels));
  for (let c = 0; c < Math.min(2, channels); c += 1) {
    const mix = new Float32Array(frames);
    buffers.forEach((buffer) => {
      const data = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
      const n = Math.min(frames, data.length);
      for (let i = 0; i < n; i += 1) mix[i] += data[i];
    });
    const a = Math.exp(-2 * Math.PI * 120 / buffers[0].sampleRate);
    let x1 = 0; let y1 = 0; let x2 = 0; let y2 = 0;
    for (let i = 0; i < frames; i += 1) {
      y1 = a * (y1 + mix[i] - x1); x1 = mix[i];
      y2 = a * (y2 + y1 - x2); x2 = y1;
      sum += y2 * y2;
    }
    count += frames;
  }
  return sum / Math.max(1, count);
}

// Look-ahead peak limiter (3 ms look-ahead, 120 ms release), applied after the loudness gain.
function limit(buffer, gain, ceiling = 0.966) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const n = buffer.length; const sr = buffer.sampleRate;
  const look = Math.max(1, Math.round(0.003 * sr));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    let peak = 0;
    for (const data of channels) peak = Math.max(peak, Math.abs(data[i]));
    peak *= gain;
    need[i] = peak > ceiling ? ceiling / peak : 1;
  }
  // Sliding minimum over the look-ahead window (monotonic deque).
  const ahead = new Float32Array(n);
  const deque = new Int32Array(n); let head = 0; let tail = 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    while (tail > head && need[deque[tail - 1]] >= need[i]) tail -= 1;
    deque[tail++] = i;
    while (deque[head] > i + look) head += 1;
    ahead[i] = need[deque[head]];
  }
  const attack = Math.exp(-1 / (0.0008 * sr)); const release = Math.exp(-1 / (0.12 * sr));
  let env = 1;
  for (let i = 0; i < n; i += 1) {
    const target = ahead[i];
    env = target < env ? target + (env - target) * attack : target + (env - target) * release;
    const g = gain * Math.min(env, need[i]);
    for (const data of channels) data[i] *= g;
  }
}

export function encodeWav(buffer) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const frames = buffer.length; const count = channels.length;
  const bytes = frames * count * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const text = (offset, value) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + bytes, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, count, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * count * 2, true);
  view.setUint16(32, count * 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, bytes, true);
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < count; c += 1) {
      // TPDF dither before 16-bit truncation.
      const sample = clamp(channels[c][i] + (Math.random() - Math.random()) / 32768, -1, 1);
      view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
      offset += 2;
    }
  }
  return new Blob([view], { type: "audio/wav" });
}
