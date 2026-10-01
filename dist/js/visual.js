import { STEM_META, VOICES } from "./presets.js";
import { clamp, DEG } from "./util.js";

/*
  Scene views. Positions are head-relative (the listener always faces "up"/forward).
  Distances are compressed so a 1 m whisper and a 40 m hall both fit on screen.
*/

const MIDS = { vocals: "vox-mid", bass: "bass-mid", drums: "kit-mid", other: "mus-mid" };
const LABELS = { vocals: "ВОКАЛ", bass: "БАС", drums: "УДАРНЫЕ", other: "МУЗЫКА" };
export const displayRadius = (d) => 2.6 * d / (d + 1.1);
export const metresFromDisplay = (r) => 1.1 * r / Math.max(0.05, 2.6 - r);

export function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr)); const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  return { width: rect.width, height: rect.height, dpr };
}

function hexAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export class StageView {
  constructor(canvas, { immersive = false } = {}) {
    this.canvas = canvas;
    this.immersive = immersive;
    this.camEl = immersive ? 18 : 26;
    this.camAz = 0;
    this.trails = VOICES.map(() => []);
    this.lastTrail = 0;
  }

  // Projects head-relative display coordinates through an orbiting camera behind the listener.
  camera(width, height) {
    const az = this.camAz * DEG; const el = this.camEl * DEG;
    const dist = this.immersive ? 5.8 : 5.7;
    const C = { x: Math.sin(az) * Math.cos(el) * dist, y: Math.sin(el) * dist, z: Math.cos(az) * Math.cos(el) * dist };
    const f = { x: -C.x / dist, y: -C.y / dist, z: -C.z / dist };
    let r = { x: -f.z, y: 0, z: f.x }; const rn = Math.hypot(r.x, r.z) || 1; r = { x: r.x / rn, y: 0, z: r.z / rn };
    const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
    const focal = Math.min(width, height) * (this.immersive ? 1.55 : 1.45);
    const cx = width / 2; const cy = height * (this.immersive ? 0.52 : 0.5);
    return (p) => {
      const v = { x: p.x - C.x, y: p.y - C.y, z: p.z - C.z };
      const zc = Math.max(0.3, v.x * f.x + v.y * f.y + v.z * f.z);
      return { x: cx + (v.x * r.x + v.y * r.y + v.z * r.z) / zc * focal, y: cy - (v.x * u.x + v.y * u.y + v.z * u.z) / zc * focal, z: zc, s: focal / zc };
    };
  }

  static toDisplay(p) {
    const k = displayRadius(p.d) / (p.d || 1);
    return { x: p.x * k, y: p.y * k, z: p.z * k };
  }

  draw(state) {
    const { width, height, dpr } = fitCanvas(this.canvas);
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (state.view === "top" && !this.immersive) this.drawTop(ctx, width, height, state);
    else this.draw3D(ctx, width, height, state);
  }

  recordTrails(points, now) {
    if (now - this.lastTrail < 45) return;
    this.lastTrail = now;
    points.forEach((p, i) => { const trail = this.trails[i]; trail.push(p); if (trail.length > (this.immersive ? 34 : 22)) trail.shift(); });
  }

  draw3D(ctx, width, height, state) {
    if (this.immersive) this.camAz = 22 * Math.sin(state.now / 9000);
    const project = this.camera(width, height);
    const alpha = this.immersive ? 0.55 : 1;

    // Floor rings at 1 m, 3 m and 10 m.
    [1, 3, 10].forEach((metres, ring) => {
      const radius = displayRadius(metres);
      ctx.beginPath();
      for (let i = 0; i <= 72; i += 1) {
        const a = i / 72 * Math.PI * 2;
        const q = project({ x: Math.sin(a) * radius, y: -0.02, z: -Math.cos(a) * radius });
        if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
      }
      ctx.strokeStyle = `rgba(241,244,234,${(0.1 - ring * 0.022) * alpha + 0.02})`; ctx.lineWidth = 1; ctx.stroke();
    });
    const outer = displayRadius(10);
    [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(([x, z]) => {
      const a = project({ x: 0, y: -0.02, z: 0 }); const b = project({ x: x * outer, y: -0.02, z: z * outer });
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(241,244,234,${0.05 * alpha + 0.01})`; ctx.stroke();
    });
    if (!this.immersive) {
      const front = project({ x: 0, y: -0.02, z: -outer * 1.06 });
      ctx.fillStyle = "rgba(241,244,234,.32)"; ctx.font = "700 8px 'Space Mono', monospace"; ctx.textAlign = "center";
      ctx.fillText("ВПЕРЕДИ", front.x, front.y - 4);
    }

    // Kick: a ring that runs outwards along the floor.
    if (state.kick > 0.03) {
      const radius = 0.3 + (1 - state.kick) * 1.2;
      ctx.beginPath();
      for (let i = 0; i <= 48; i += 1) {
        const a = i / 48 * Math.PI * 2; const q = project({ x: Math.sin(a) * radius, y: -0.02, z: Math.cos(a) * radius });
        if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
      }
      ctx.strokeStyle = `rgba(223,255,79,${0.45 * state.kick * alpha})`; ctx.lineWidth = 1.4; ctx.stroke();
    }

    const points = state.viz.map((p) => StageView.toDisplay(p));
    this.recordTrails(points, state.now);
    const order = points.map((p, i) => ({ i, q: project(p) })).sort((a, b) => b.q.z - a.q.z);
    const head = project({ x: 0, y: 0, z: 0 });

    const drawHead = () => {
      const r = 0.15 * head.s;
      ctx.fillStyle = "#0b0d0f"; ctx.strokeStyle = this.immersive ? "rgba(223,255,79,.55)" : "#dfff4f"; ctx.lineWidth = 1.5;
      [-1, 1].forEach((side) => {
        const ear = project({ x: side * 0.15, y: 0, z: 0 });
        ctx.beginPath(); ctx.ellipse(ear.x, ear.y, r * 0.22, r * 0.36, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      });
      ctx.beginPath(); ctx.arc(head.x, head.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      const nose = project({ x: 0, y: 0, z: -0.24 });
      ctx.beginPath(); ctx.moveTo(head.x, head.y); ctx.lineTo(nose.x, nose.y); ctx.stroke();
    };

    let headDrawn = false;
    order.forEach(({ i, q }) => {
      if (!headDrawn && q.z < head.z) { drawHead(); headDrawn = true; }
      const voice = VOICES[i]; const meta = STEM_META[voice.stem];
      const enabled = state.enabled[voice.stem];
      const energy = state.energies[voice.stem] || 0;
      const main = voice.part === "mid";
      const fade = (enabled ? 1 : 0.18) * alpha;
      const trail = this.trails[i];
      if (trail.length > 2) {
        for (let k = 1; k < trail.length; k += 1) {
          const a = project(trail[k - 1]); const b = project(trail[k]);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = hexAlpha(meta.color, 0.32 * (k / trail.length) * fade); ctx.lineWidth = 1.2; ctx.stroke();
        }
      }
      const floor = project({ x: points[i].x, y: -0.02, z: points[i].z });
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(floor.x, floor.y);
      ctx.strokeStyle = hexAlpha(meta.color, 0.2 * fade); ctx.lineWidth = 1; ctx.stroke();
      ctx.setLineDash([]);
      const size = clamp(q.s * (main ? 0.075 : 0.05) * (1 + energy * 0.9), 2.2, this.immersive ? 26 : 13);
      const glow = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, size * 3.2);
      glow.addColorStop(0, hexAlpha(meta.color, 0.5 * fade * (0.5 + energy)));
      glow.addColorStop(1, hexAlpha(meta.color, 0));
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(q.x, q.y, size * 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = hexAlpha(meta.color, fade); ctx.beginPath(); ctx.arc(q.x, q.y, size, 0, Math.PI * 2); ctx.fill();
    });
    if (!headDrawn) drawHead();
  }

  topGeometry(width, height) {
    return { cx: width / 2, cy: height * 0.52, scale: Math.min(width, height) * 0.4 / displayRadius(10) };
  }

  drawTop(ctx, width, height, state) {
    const { cx, cy, scale } = this.topGeometry(width, height);
    ctx.strokeStyle = "rgba(241,244,234,.085)"; ctx.lineWidth = 1;
    [1, 3, 10].forEach((metres) => { ctx.beginPath(); ctx.arc(cx, cy, displayRadius(metres) * scale, 0, Math.PI * 2); ctx.stroke(); });
    ctx.beginPath(); ctx.moveTo(cx, 14); ctx.lineTo(cx, height - 20); ctx.moveTo(18, cy); ctx.lineTo(width - 18, cy); ctx.stroke();
    ctx.fillStyle = "rgba(241,244,234,.3)"; ctx.font = "700 8px 'Space Mono', monospace"; ctx.textAlign = "center";
    ["1 М", "3 М", "10 М"].forEach((label, i) => ctx.fillText(label, cx + 4 + displayRadius([1, 3, 10][i]) * scale * 0.71, cy - displayRadius([1, 3, 10][i]) * scale * 0.71));
    if (state.kick > 0.02) {
      ctx.strokeStyle = `rgba(223,255,79,${0.5 * state.kick})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, 18 + (1 - state.kick) * scale * 0.6, 0, Math.PI * 2); ctx.stroke();
    }
    this.handles = {};
    state.viz.forEach((p, i) => {
      const voice = VOICES[i]; const meta = STEM_META[voice.stem];
      const d = StageView.toDisplay(p);
      const px = cx + d.x * scale; const py = cy + d.z * scale;
      const energy = state.energies[voice.stem] || 0;
      const enabled = state.enabled[voice.stem];
      const main = voice.part === "mid";
      ctx.globalAlpha = enabled ? 1 : 0.25;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(px, py); ctx.strokeStyle = hexAlpha(meta.color, 0.14); ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, (main ? 4.8 : 3.2) + energy * (main ? 3.8 : 2.4), 0, Math.PI * 2);
      ctx.fillStyle = meta.color; ctx.shadowColor = meta.color; ctx.shadowBlur = 8 + energy * 16; ctx.fill(); ctx.shadowBlur = 0;
      if (main && state.editing) {
        ctx.strokeStyle = hexAlpha(meta.color, 0.6); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(px, py, 11, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = hexAlpha(meta.color, 0.85); ctx.font = "700 7px 'Space Mono', monospace";
        ctx.fillText(LABELS[voice.stem], px, py - 15);
      }
      ctx.globalAlpha = 1;
      if (main) this.handles[voice.stem] = { x: px, y: py };
    });
    ctx.fillStyle = "#0b0d0f"; ctx.strokeStyle = "#dfff4f"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - 6, cy - 1); ctx.quadraticCurveTo(cx, cy - 8, cx + 6, cy - 1); ctx.stroke();
    ctx.fillStyle = "#dfff4f"; ctx.font = "700 8px 'Space Mono', monospace"; ctx.textAlign = "center"; ctx.fillText("ТЫ", cx, cy + 28);
  }

  // Top view: which stem handle is under the pointer, and where a point lands in metres/degrees.
  hitStem(x, y) {
    if (!this.handles) return null;
    let best = null; let bestDistance = 16;
    Object.entries(this.handles).forEach(([stem, h]) => {
      const distance = Math.hypot(h.x - x, h.y - y);
      if (distance < bestDistance) { bestDistance = distance; best = stem; }
    });
    return best;
  }

  pointToPolar(x, y) {
    const rect = this.canvas.getBoundingClientRect();
    const { cx, cy, scale } = this.topGeometry(rect.width, rect.height);
    const dx = (x - cx) / scale; const dz = (y - cy) / scale;
    const r = clamp(Math.hypot(dx, dz), 0.15, displayRadius(14));
    return { az: Math.atan2(dx, -dz) / DEG, d: metresFromDisplay(r) };
  }
}

export { MIDS };

export function drawSpectrum(canvas, analyser, now) {
  const { width, height, dpr } = fitCanvas(canvas); const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
  const count = Math.max(36, Math.floor(width / 9)); let values;
  if (analyser) { values = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(values); }
  const center = height / 2; const gap = width / count;
  for (let i = 0; i < count; i += 1) {
    const index = values ? Math.floor(Math.pow(i / count, 1.7) * values.length) : i;
    const idle = 0.08 + 0.13 * Math.sin(i * 1.67 + now / 1200) ** 2;
    const level = values ? values[index] / 255 : idle; const bar = Math.max(2, level * center * 0.88);
    ctx.fillStyle = `rgba(223,255,79,${0.24 + level * 0.76})`;
    ctx.fillRect(i * gap + 1, center - bar, Math.max(2, gap - 4), bar * 2);
  }
}
