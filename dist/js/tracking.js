import { clamp } from "./util.js";

/*
  Head tracking. With the head locked to the scene the brain gets the dynamic cues it uses to
  put sound outside the head and to tell front from back — the single biggest step towards
  "being there". Two sources: the phone gyroscope, or any webcam via MediaPipe face landmarks.
*/

const VISION_VERSION = "0.10.14";
const VISION_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// One Euro filter: smooth when still, responsive when moving.
class OneEuro {
  constructor(minCutoff = 1.4, beta = 0.35, dCutoff = 1) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: 0 });
  }

  filter(value, t) {
    if (this.x === null) { this.x = value; this.t = t; return value; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    const alpha = (cutoff) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    const dx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff) * (value - this.x);
    return this.x;
  }
}

export class HeadTracker {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.source = null;
    this.yaw = 0; this.pitch = 0;
    this.raw = { yaw: 0, pitch: 0 };
    this.base = null;
    this.invert = false;
    this.filters = { yaw: new OneEuro(), pitch: new OneEuro() };
    this.onOrientation = this.onOrientation.bind(this);
  }

  emit(yaw, pitch) {
    this.raw = { yaw, pitch };
    if (!this.base) this.base = { yaw, pitch };
    const t = performance.now() / 1000;
    let dy = yaw - this.base.yaw;
    if (dy > Math.PI) dy -= 2 * Math.PI; if (dy < -Math.PI) dy += 2 * Math.PI;
    const sign = this.invert ? -1 : 1;
    this.yaw = sign * this.filters.yaw.filter(dy, t);
    this.pitch = sign * clamp(this.filters.pitch.filter(pitch - this.base.pitch, t), -1, 1);
    this.onUpdate(this.yaw, this.pitch);
  }

  recenter() {
    this.base = { ...this.raw };
    this.filters = { yaw: new OneEuro(), pitch: new OneEuro() };
  }

  async startGyro() {
    this.stop();
    if (!("DeviceOrientationEvent" in window)) throw new Error("Нет гироскопа");
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") throw new Error("Доступ к датчику запрещён");
    }
    this.base = null;
    window.addEventListener("deviceorientation", this.onOrientation);
    this.source = "gyro";
  }

  onOrientation(event) {
    if (event.alpha == null) return;
    // alpha grows when the device turns left (counter-clockwise seen from above).
    this.emit(-event.alpha * Math.PI / 180, 0);
  }

  async startCamera(video, onStatus = () => {}) {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Камера недоступна");
    onStatus("КАМЕРА · ДОСТУП");
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    video.srcObject = this.stream;
    video.muted = true; video.playsInline = true;
    await video.play();
    onStatus("КАМЕРА · ЗАГРУЗКА МОДЕЛИ");
    const vision = await import(/* webpackIgnore: true */ `${VISION_URL}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${VISION_URL}/wasm`);
    const create = (delegate) => vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO", numFaces: 1,
    });
    this.landmarker = await create("GPU").catch(() => create("CPU"));
    this.base = null;
    this.source = "camera";
    this.video = video;
    this.lastFace = 0;
    let lastTime = -1;
    // requestVideoFrameCallback fires once per new camera frame; the rAF fallback de-duplicates by time.
    const loop = (now, metadata) => {
      if (this.source !== "camera") return;
      const stamp = metadata ? metadata.presentedFrames : video.currentTime;
      if (video.readyState >= 2 && stamp !== lastTime) {
        lastTime = stamp;
        const result = this.landmarker.detectForVideo(video, performance.now());
        const points = result.faceLandmarks?.[0];
        if (points) { this.lastFace = performance.now(); this.fromLandmarks(points, video.videoWidth, video.videoHeight); }
      }
      this.frame = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(loop);
    };
    loop();
  }

  // Head pose from 3D landmarks (image x → right, y → down, z → away from the camera, z in
  // roughly the units of x). The face normal is the cross product of the cheek-to-cheek and
  // forehead-to-chin axes, so tilting the head sideways (roll) does not leak into yaw or pitch.
  static poseFromLandmarks(points, width, height) {
    const p = (i) => ({ x: points[i].x * width, y: points[i].y * height, z: points[i].z * width });
    const right = p(234); const left = p(454); const top = p(10); const chin = p(152);
    const a = { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
    const d = { x: chin.x - top.x, y: chin.y - top.y, z: chin.z - top.z };
    // Points out of the face, towards the camera when looking straight at it.
    const forward = { x: -(a.y * d.z - a.z * d.y), y: -(a.z * d.x - a.x * d.z), z: -(a.x * d.y - a.y * d.x) };
    // Turning right (towards image left) → forward.x < 0; looking up → forward.y < 0.
    const yaw = Math.atan2(-forward.x, -forward.z);
    const pitch = Math.atan2(-forward.y, Math.hypot(forward.x, forward.z));
    return { yaw, pitch };
  }

  fromLandmarks(points, width, height) {
    const { yaw, pitch } = HeadTracker.poseFromLandmarks(points, width, height);
    this.emit(yaw, pitch);
  }

  get faceVisible() {
    return this.source === "camera" && performance.now() - (this.lastFace || 0) < 800;
  }

  stop() {
    window.removeEventListener("deviceorientation", this.onOrientation);
    if (this.stream) { this.stream.getTracks().forEach((track) => track.stop()); this.stream = null; }
    if (this.video) { this.video.srcObject = null; this.video = null; }
    this.landmarker?.close?.(); this.landmarker = null;
    this.source = null;
    this.yaw = 0; this.pitch = 0;
    this.onUpdate(0, 0);
  }
}
