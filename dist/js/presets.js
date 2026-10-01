export const STEM_NAMES = ["vocals", "bass", "drums", "other"];

// `room` scales how much of a stem is sent into the virtual room (bass highs stay drier, pads wetter).
export const STEM_META = {
  vocals: { label: "VOCAL", room: 0.8, color: "#67e8f9" },
  bass: { label: "BASS", room: 0.3, color: "#dfff4f" },
  drums: { label: "DRUMS", room: 0.65, color: "#ff9f67" },
  other: { label: "MUSIC", room: 1, color: "#f3f4ef" },
};

// Every stem is split into a mono centre (mid) and a decorrelated pair (side) so the
// lead stays locked while doubles, reverbs and wide synths can move around you.
// Drums additionally get an "air" band (hats, shakers, cymbals) that is choreographed separately.
export const VOICES = [
  { id: "vox-mid", stem: "vocals", band: "main", part: "mid" },
  { id: "vox-l", stem: "vocals", band: "main", part: "sideL" },
  { id: "vox-r", stem: "vocals", band: "main", part: "sideR" },
  { id: "bass-mid", stem: "bass", band: "main", part: "mid" },
  { id: "bass-l", stem: "bass", band: "main", part: "sideL" },
  { id: "bass-r", stem: "bass", band: "main", part: "sideR" },
  { id: "kit-mid", stem: "drums", band: "body", part: "mid" },
  { id: "kit-l", stem: "drums", band: "body", part: "sideL" },
  { id: "kit-r", stem: "drums", band: "body", part: "sideR" },
  { id: "hat-l", stem: "drums", band: "air", part: "left" },
  { id: "hat-r", stem: "drums", band: "air", part: "right" },
  { id: "mus-mid", stem: "other", band: "main", part: "mid" },
  { id: "mus-l", stem: "other", band: "main", part: "sideL" },
  { id: "mus-r", stem: "other", band: "main", part: "sideR" },
];

// Below this frequency nothing is localised by the ear, so lows skip HRTF entirely and stay punchy.
export const CROSSOVER_HZ = 140;
export const AIR_HZ = 6500;

export const MODES = [
  { id: "stage", label: "Сцена", hint: "группа перед тобой" },
  { id: "inside", label: "Внутри", hint: "инструменты вокруг" },
  { id: "pulse", label: "Пульс", hint: "движение под бит" },
  { id: "orbit", label: "8D", hint: "трек кружит вокруг", orbit: true },
  { id: "vortex", label: "Вихрь", hint: "стемы кружат по-разному", orbit: true },
  { id: "dream", label: "Дрейф", hint: "медленно плывёт" },
  { id: "custom", label: "Свой", hint: "расставь стемы" },
];

export const ORBIT_BARS = [2, 4, 8, 16];

// Shoebox rooms for the image-source early reflections + binaural diffuse tail.
// dims/listener in metres: [width x, height y, depth z]; the listener faces −z (the z = 0 wall).
// beta = wall reflection coefficients [left, right, floor, ceiling, front, back].
// rt = reverb time per band [low, mid, high]; q = source directivity for the critical distance.
// wet = calibration of the whole reflected field so that at "Отражения 100%" every room keeps a
// musical direct-to-reverberant ratio (measured above 400 Hz): studio ≈ +5 dB … cathedral ≈ −1 dB.
export const ROOMS = [
  { id: "dry", label: "Сухо", hint: "без отражений" },
  {
    id: "studio", label: "Студия", hint: "тихая комната",
    dims: [6.2, 3, 5.4], listener: [3.1, 1.25, 3.4], beta: [0.7, 0.7, 0.8, 0.6, 0.75, 0.55],
    rt: [0.34, 0.3, 0.22], bright: 11000, q: 2, order: 3, window: 0.05, tMix: 0.012, tailScale: 1, wet: 0.55,
  },
  {
    id: "bathroom", label: "Ванная", hint: "кафель, звенит",
    dims: [2.3, 2.5, 2.9], listener: [1.15, 1.55, 1.9], beta: [0.93, 0.93, 0.95, 0.9, 0.93, 0.92],
    rt: [0.95, 1.15, 0.85], bright: 12000, q: 1.5, order: 3, window: 0.035, tMix: 0.006, tailScale: 0.55, wet: 0.43,
  },
  {
    id: "club", label: "Клуб", hint: "тёмный зал, толпа",
    dims: [15, 4.2, 12], listener: [7.5, 1.7, 8.5], beta: [0.8, 0.8, 0.7, 0.75, 0.85, 0.8],
    rt: [1.4, 1.05, 0.7], bright: 7000, q: 2, order: 2, window: 0.08, tMix: 0.03, tailScale: 1, wet: 1.2,
  },
  {
    id: "hall", label: "Зал", hint: "концертный зал",
    dims: [30, 16, 40], listener: [15, 1.7, 24], beta: [0.86, 0.86, 0.7, 0.85, 0.9, 0.8],
    rt: [2.5, 2.05, 1.5], bright: 5500, q: 2, order: 2, window: 0.12, tMix: 0.06, tailScale: 1, wet: 1.45,
  },
  {
    id: "cathedral", label: "Собор", hint: "камень, 5 секунд",
    dims: [24, 28, 64], listener: [12, 1.7, 36], beta: [0.95, 0.95, 0.93, 0.95, 0.95, 0.95],
    rt: [6, 4.8, 3.2], bright: 4200, q: 2, order: 2, window: 0.16, tMix: 0.09, tailScale: 1, wet: 1.6,
  },
  {
    id: "openair", label: "Опен-эйр", hint: "поле и эхо трибун",
    dims: [90, 40, 130], listener: [45, 1.7, 80], beta: [0, 0, 0.6, 0, 0.3, 0.42],
    rt: [1.3, 1, 0.6], bright: 6500, q: 3, order: 2, window: 0.42, tMix: 0.12, tailScale: 0.3, wet: 2.6,
  },
];

export const AMBIENCES = [
  { id: "none", label: "Нет" },
  { id: "rain", label: "Дождь" },
  { id: "ocean", label: "Океан" },
  { id: "wind", label: "Ветер" },
  { id: "fire", label: "Камин" },
  { id: "night", label: "Ночь" },
  { id: "vinyl", label: "Винил" },
];

export const RATES = [
  { value: 0.8, label: "0.8×", hint: "slowed" },
  { value: 0.9, label: "0.9×", hint: "" },
  { value: 1, label: "1×", hint: "оригинал" },
  { value: 1.12, label: "1.12×", hint: "" },
  { value: 1.25, label: "1.25×", hint: "nightcore" },
];

export const DEFAULT_SETTINGS = {
  experience: "inside",
  mode: "inside",
  orbitBars: 4,
  room: "studio",
  width: 1.1,
  distance: 1.6,
  motion: 0.45,
  roomAmt: 1.1,
  cue: 0.65,
  bass: 1,
  rate: 1,
  // Effects, independent of the scene: Slowed (turntable speed) and Reverb (lush tail).
  slowRate: 0.85,
  fxReverb: false,
  fxAmount: 0.55,
  ambience: "none",
  ambienceLevel: 0.5,
  // Automatic style detection picks the scene for every new track until a scene is chosen by hand.
  autoStyle: true,
  style: null,
  autoLyrics: true,
  uiMode: "simple",
  spatial: true,
  headphone: true,
  view: "3d",
  sceneYaw: 0,
  trackInvert: false,
  // Custom layout: azimuth/elevation in degrees, r relative to the distance setting.
  custom: {
    vocals: { az: 0, el: 4, r: 0.95 },
    bass: { az: 0, el: -12, r: 0.85 },
    drums: { az: -35, el: 2, r: 1.25 },
    other: { az: 150, el: 8, r: 1.3 },
  },
};

// One-tap experiences: each one is a full set of scene settings.
export const EXPERIENCES = [
  {
    id: "tiktok", title: "8D", sub: "трек летает вокруг головы",
    settings: { mode: "orbit", orbitBars: 4, room: "hall", width: 1, distance: 1.7, motion: 0.55, roomAmt: 2.2, cue: 0.75, bass: 2, ambience: "none" },
  },
  {
    id: "concert", title: "Концерт", sub: "ты в зале, группа на сцене",
    settings: { mode: "stage", room: "hall", width: 1.15, distance: 7, motion: 0.3, roomAmt: 1, cue: 0.55, bass: 3, ambience: "none" },
  },
  {
    id: "inside", title: "Внутри трека", sub: "инструменты вокруг тебя",
    settings: { mode: "inside", room: "studio", width: 1.1, distance: 1.6, motion: 0.45, roomAmt: 1.1, cue: 0.65, bass: 1, ambience: "none" },
  },
  {
    id: "dance", title: "Танцпол", sub: "всё двигается под бит",
    settings: { mode: "pulse", room: "club", width: 1.1, distance: 1.7, motion: 0.8, roomAmt: 0.9, cue: 0.65, bass: 5, ambience: "none" },
  },
  {
    id: "slowed", title: "Slowed + Reverb", sub: "медленно, глубоко, ночью",
    settings: { mode: "orbit", orbitBars: 8, room: "cathedral", width: 1.2, distance: 2.4, motion: 0.4, roomAmt: 1.6, cue: 0.6, bass: 4, ambience: "none", rate: 0.85, slowRate: 0.85, fxReverb: true },
  },
  {
    id: "rain", title: "Дождь за окном", sub: "тёплая комната, ливень",
    settings: { mode: "inside", room: "studio", width: 1, distance: 2, motion: 0.3, roomAmt: 1.2, cue: 0.6, bass: 2, ambience: "rain", ambienceLevel: 0.55 },
  },
  {
    id: "space", title: "Невесомость", sub: "плывёшь в пустоте",
    settings: { mode: "dream", room: "cathedral", width: 1.3, distance: 3, motion: 0.6, roomAmt: 1.3, cue: 0.7, bass: 3, ambience: "none" },
  },
  {
    id: "studio", title: "Студия", sub: "как у звукорежиссёра",
    settings: { mode: "stage", room: "studio", width: 1, distance: 1.8, motion: 0.12, roomAmt: 1, cue: 0.5, bass: 0, ambience: "none" },
  },
];

export const findRoom = (id) => ROOMS.find((room) => room.id === id) || ROOMS[0];
