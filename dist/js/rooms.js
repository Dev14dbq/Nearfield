import { cartesian, clamp, energy, fibonacciSphere, renderOffline, seededRandom } from "./util.js";

/*
  Binaural room model.
  • Early reflections: image-source method in a shoebox (up to 3rd order) with wall absorption,
    rendered in JS through the measured HRIR grid — each reflection arrives from its true direction.
    They are pre-computed for 8 source directions ("zones" every 45°); live voices are panned
    between the two nearest zones, so reflections follow the sources as they move.
  • Late tail: independent decaying noise from 18 directions on a sphere rendered through the
    browser HRTF, which gives the correct interaural coherence of a diffuse field — the reverb
    surrounds you instead of sitting between the ears.
  Levels are physical: the tail energy follows the room's critical distance.
*/

export const ZONES = 8;
const SPEED_OF_SOUND = 343;

export function roomVolume(room) {
  return room.dims[0] * room.dims[1] * room.dims[2];
}

export function criticalDistance(room) {
  return 0.057 * Math.sqrt(room.q * roomVolume(room) / room.rt[1]);
}

const imageCoord = (n, size, s) => (n % 2 === 0 ? n * size + s : (n + 1) * size - s);
// Number of hits on the [near (0), far (size)] walls for image index n.
const wallHits = (n) => (n >= 0 ? [Math.floor(n / 2), Math.ceil(n / 2)] : [Math.ceil(-n / 2), Math.floor(-n / 2)]);

function filteredHrir(grid, cache, index, bounces, bright) {
  const key = `${index}:${bounces}`;
  if (cache.has(key)) return cache.get(key);
  const cutoff = Math.min(grid.sampleRate * 0.45, bright * 0.7 ** Math.max(0, bounces - 1));
  const a = 1 - Math.exp(-2 * Math.PI * cutoff / grid.sampleRate);
  const filter = (src) => {
    const out = new Float32Array(src.length);
    let y = 0;
    for (let i = 0; i < src.length; i += 1) { y += a * (src[i] - y); out[i] = y; }
    return out;
  };
  const value = [filter(grid.left[index]), filter(grid.right[index])];
  cache.set(key, value);
  return value;
}

export function buildEarlyZones(room, distance, grid) {
  const sampleRate = grid.sampleRate;
  const [Lx, Ly, Lz] = room.dims;
  const [px, py, pz] = room.listener;
  const length = Math.ceil((room.window + 0.01) * sampleRate) + grid.length;
  const cache = new Map();
  const zones = [];
  for (let k = 0; k < ZONES; k += 1) {
    const rand = seededRandom(9001 + k * 77);
    const dir = cartesian(k * 360 / ZONES, 0, 1);
    const sx = clamp(px + dir.x * distance, 0.3, Lx - 0.3);
    const sy = py;
    const sz = clamp(pz + dir.z * distance, 0.3, Lz - 0.3);
    const direct = Math.hypot(sx - px, sy - py, sz - pz);
    const left = new Float32Array(length); const right = new Float32Array(length);
    const addTap = (delay, gain, vector, bounces) => {
      const offset = Math.round(delay * sampleRate);
      if (offset < 0 || offset >= length - grid.length) return;
      const [hl, hr] = filteredHrir(grid, cache, grid.nearest(vector), bounces, room.bright);
      for (let i = 0; i < grid.length; i += 1) { left[offset + i] += gain * hl[i]; right[offset + i] += gain * hr[i]; }
    };
    const N = room.order;
    for (let nx = -N; nx <= N; nx += 1) {
      for (let ny = -N; ny <= N; ny += 1) {
        for (let nz = -N; nz <= N; nz += 1) {
          const order = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
          if (order === 0 || order > N) continue;
          const [hx0, hx1] = wallHits(nx); const [hy0, hy1] = wallHits(ny); const [hz0, hz1] = wallHits(nz);
          const b = room.beta;
          const reflection = b[0] ** hx0 * b[1] ** hx1 * b[2] ** hy0 * b[3] ** hy1 * b[4] ** hz0 * b[5] ** hz1;
          if (reflection < 1e-3) continue;
          const ix = imageCoord(nx, Lx, sx); const iy = imageCoord(ny, Ly, sy); const iz = imageCoord(nz, Lz, sz);
          const vector = { x: ix - px, y: iy - py, z: iz - pz };
          const dist = Math.hypot(vector.x, vector.y, vector.z);
          const delay = (dist - direct) / SPEED_OF_SOUND;
          if (delay <= 0 || delay > room.window) continue;
          // Late reflections hand over smoothly to the diffuse tail.
          const taper = delay > room.window * 0.6 ? Math.cos((delay / room.window - 0.6) / 0.4 * Math.PI / 2) ** 2 : 1;
          const gain = reflection / dist * taper;
          if (gain < 1e-5) continue;
          // A specular tap plus two scattered ones (rough walls), slightly later and from nearby directions.
          addTap(delay, gain * 0.8, vector, order);
          for (let s = 0; s < 2; s += 1) {
            const jitter = { x: vector.x + (rand() - 0.5) * dist * 0.3, y: vector.y + (rand() - 0.5) * dist * 0.2, z: vector.z + (rand() - 0.5) * dist * 0.3 };
            addTap(delay + (0.25 + rand() * 1.1) / 1000 * (1 + order * 0.5), gain * (0.25 + 0.15 * rand()) * (rand() < 0.5 ? -1 : 1), jitter, order + 1);
          }
        }
      }
    }
    const buffer = new AudioBuffer({ numberOfChannels: 2, length, sampleRate });
    buffer.copyToChannel(left, 0); buffer.copyToChannel(right, 1);
    zones.push(buffer);
  }
  return zones;
}

function tailNoise(length, sampleRate, room, seed, targetEnergy) {
  const rand = seededRandom(seed);
  const out = new Float32Array(length);
  const aLow = 1 - Math.exp(-2 * Math.PI * 400 / sampleRate);
  const aHigh = 1 - Math.exp(-2 * Math.PI * 3800 / sampleRate);
  const [rtLow, rtMid, rtHigh] = room.rt;
  const kLow = Math.exp(-6.91 / (rtLow * sampleRate));
  const kMid = Math.exp(-6.91 / (rtMid * sampleRate));
  const kHigh = Math.exp(-6.91 / (rtHigh * sampleRate));
  const onset = Math.max(1, room.tMix * sampleRate);
  let lp1 = 0; let lp2 = 0; let eLow = 1; let eMid = 1; let eHigh = 1;
  for (let i = 0; i < length; i += 1) {
    const n = rand() + rand() - 1;
    lp1 += aLow * (n - lp1); lp2 += aHigh * (n - lp2);
    const value = lp1 * eLow + (lp2 - lp1) * eMid + (n - lp2) * eHigh;
    const fade = i < onset ? (i / onset) ** 2 : 1;
    out[i] = value * fade;
    eLow *= kLow; eMid *= kMid; eHigh *= kHigh;
  }
  const scale = Math.sqrt(targetEnergy / (energy(out) || 1));
  for (let i = 0; i < length; i += 1) out[i] *= scale;
  return out;
}

export async function renderLateTail(room, sampleRate) {
  const length = Math.ceil((room.tMix + Math.max(...room.rt) * 1.1) * sampleRate);
  const directions = fibonacciSphere(18, -35, 80);
  const total = room.tailScale / criticalDistance(room) ** 2;
  const sources = directions.map((_, i) => tailNoise(length, sampleRate, room, 31337 + i * 101, total / directions.length));
  return renderOffline(2, length + 1024, sampleRate, (offline) => {
    directions.forEach((vector, i) => {
      const buffer = offline.createBuffer(1, length, sampleRate);
      buffer.copyToChannel(sources[i], 0);
      const source = offline.createBufferSource(); source.buffer = buffer;
      const panner = offline.createPanner();
      panner.panningModel = "HRTF"; panner.rolloffFactor = 0;
      panner.positionX.value = vector.x; panner.positionY.value = vector.y; panner.positionZ.value = vector.z;
      source.connect(panner); panner.connect(offline.destination); source.start();
    });
  }, (buffer) => energy(buffer.getChannelData(0), 0, Math.min(buffer.length, sampleRate)) > total * 1e-4);
}

// Cache: the tail depends only on the room, early reflections also on the source distance.
export class RoomLibrary {
  constructor(grid) {
    this.grid = grid;
    this.tails = new Map();
    this.early = new Map();
  }

  static distanceBucket(distance) {
    return 2 ** (Math.round(Math.log2(clamp(distance, 0.6, 16)) * 2) / 2);
  }

  async get(room, distance) {
    if (!room?.dims) return null;
    const bucket = RoomLibrary.distanceBucket(distance);
    const earlyKey = `${room.id}|${bucket}`;
    if (!this.tails.has(room.id)) this.tails.set(room.id, renderLateTail(room, this.grid.sampleRate));
    if (!this.early.has(earlyKey)) this.early.set(earlyKey, buildEarlyZones(room, bucket, this.grid));
    const tail = await this.tails.get(room.id);
    return { key: earlyKey, zones: this.early.get(earlyKey), tail, room };
  }
}
