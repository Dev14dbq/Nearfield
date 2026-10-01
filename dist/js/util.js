export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const mod = (value, n) => ((value % n) + n) % n;
export const lerp = (a, b, k) => a + (b - a) * k;
export const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Deterministic generator so rooms and ambiences sound the same on every load.
export function seededRandom(seed) {
  let state = (seed >>> 0) % 2147483647 || 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

// Web Audio coordinates: x → right, y → up, −z → in front of the listener.
export function cartesian(azDeg, elDeg, distance = 1) {
  const a = azDeg * DEG; const e = elDeg * DEG;
  return { x: Math.sin(a) * Math.cos(e) * distance, y: Math.sin(e) * distance, z: -Math.cos(a) * Math.cos(e) * distance };
}

export function spherical({ x, y, z }) {
  const d = Math.hypot(x, y, z) || 1e-9;
  return { az: Math.atan2(x, -z) / DEG, el: Math.asin(clamp(y / d, -1, 1)) / DEG, d };
}

// Evenly spread points on a sphere, limited to an elevation band.
export function fibonacciSphere(count, minEl = -90, maxEl = 90) {
  const points = [];
  const lo = Math.sin(minEl * DEG); const hi = Math.sin(maxEl * DEG);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const y = lo + (hi - lo) * (i + 0.5) / count;
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i;
    points.push({ x: Math.cos(theta) * r, y, z: Math.sin(theta) * r });
  }
  return points;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

// Renders an offline graph, retrying while the browser is still loading its HRTF database
// (until then HRTF panners output silence).
export async function renderOffline(channels, length, sampleRate, setup, isValid = () => true, attempts = 4) {
  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const offline = new OfflineContext(channels, length, sampleRate);
    setup(offline);
    const rendered = await offline.startRendering();
    if (isValid(rendered)) return rendered;
    if (attempt < attempts - 1) await sleep(150 + attempt * 150);
  }
  throw new Error("HRTF база браузера не загрузилась");
}

export function energy(data, start = 0, end = data.length) {
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += data[i] * data[i];
  return sum;
}
