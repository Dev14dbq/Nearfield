import { api, listen } from "./api.js";
import { drawFrame, nowPlaying, openQueue, openSound, paintRange, syncVolume } from "./nowplaying.js";
import { analyzeInBackground, player } from "./player.js";
import { library, refreshPlaylists, toggleFavorite } from "./tracks.js";
import { $, $$, artistNames, coverTone, fmtTime, plural, toast } from "./ui.js";
import { currentView, goBack, navigate, renderSidePlaylists } from "./views.js";
import "./wave.js";

const els = {
  play: $("#playBtn"), prev: $("#prevBtn"), next: $("#nextBtn"), shuffle: $("#shuffleBtn"), repeat: $("#repeatBtn"),
  seek: $("#seek"), cur: $("#curTime"), dur: $("#durTime"), title: $("#pbTitle"), artist: $("#pbArtist"),
  coverImg: $("#pbCoverImg"), heart: $("#pbHeart"), status: $("#pbStatus"), volume: $("#volume"),
  d3: $("#pb3d"), sound: $("#pbSound"),
};
nowPlaying.setNavigator(navigate);

/* ───── player bar (hidden until something is loaded, and while the full player is open) ───── */

function renderBar() {
  const track = player.track;
  document.body.classList.toggle("no-track", !track);
  if (!track) return;
  els.title.textContent = track.title;
  els.artist.textContent = artistNames(track);
  if (els.coverImg.getAttribute("src") !== (track.cover || "")) els.coverImg.src = track.cover || "";
  els.coverImg.hidden = !track.cover;
  els.heart.classList.toggle("on", Boolean(library.get(track.id)?.favorite));
  renderState();
}

function renderState() {
  els.play.classList.toggle("playing", player.playing);
  els.play.classList.toggle("loading", Boolean(player.loadingTrack));
  els.shuffle.classList.toggle("on", player.shuffle);
  els.repeat.classList.toggle("on", player.repeat !== "off");
  els.repeat.classList.toggle("one", player.repeat === "one");
  const s = player.settings;
  els.d3.classList.toggle("on", s.spatial);
  els.sound.classList.toggle("on", s.rate !== 1 || s.fxReverb || s.ambience !== "none" || player.soundMode === "track");
  els.sound.title = s.rate < 1 ? "Звук трека · Slowed" : s.rate > 1 ? "Звук трека · Speed up" : "Звук трека";
  $$(".trow").forEach((row) => {
    const now = row.dataset.id === player.track?.id;
    row.classList.toggle("playing", now);
    row.classList.toggle("paused", now && !player.playing);
  });
}

player.on("track", renderBar);
player.on("state", renderState);
player.on("loading", renderState);
player.on("settings", renderState);
player.on("queue", renderState);
player.on("status", ({ text, busy }) => { els.status.textContent = busy && text ? text.toLowerCase() : ""; });
player.on("error", ({ message }) => toast(`Не играет: ${message}`, { error: true }));
player.on("needsGesture", () => toast("Нажми ▶"));
player.on("moodExhausted", async () => {
  if (player.context?.type !== "mood") return;
  const { startMood } = await import("./views.js");
  startMood(player.context.id);
});

els.play.addEventListener("click", () => player.toggle());
els.prev.addEventListener("click", () => player.prev());
els.next.addEventListener("click", () => player.next());
els.shuffle.addEventListener("click", () => player.setShuffle(!player.shuffle));
els.repeat.addEventListener("click", () => player.cycleRepeat());
els.d3.addEventListener("click", () => player.toggleSpatial());
els.sound.addEventListener("click", openSound);
$("#queueBtn").addEventListener("click", openQueue);
$("#pbCover").addEventListener("click", () => nowPlaying.show());
$(".pb-meta").addEventListener("click", () => nowPlaying.show());
els.heart.addEventListener("click", async () => { if (player.track) { await toggleFavorite(player.track); renderBar(); } });
els.seek.addEventListener("input", () => {
  const duration = player.engine.duration || player.track?.duration || 0;
  player.engine.seek(Number(els.seek.value) / 1000 * duration);
  paintRange(els.seek);
});
els.coverImg.addEventListener("load", async () => {
  const color = await coverTone(els.coverImg.getAttribute("src"), els.coverImg, 0.5);
  if (color) $("#playerbar").style.setProperty("--pb-color", color);
});
let lastVolume = 0.85;
$("#muteBtn").addEventListener("click", () => {
  if (player.volume > 0) { lastVolume = player.volume; player.setVolume(0); } else player.setVolume(lastVolume || 0.85);
  els.volume.value = Math.round(player.volume * 100); paintRange(els.volume); syncVolume();
  $("#muteBtn").classList.toggle("muted", player.volume === 0);
});
els.volume.addEventListener("input", () => { player.setVolume(Number(els.volume.value) / 100); paintRange(els.volume); syncVolume(); });
document.addEventListener("volume-changed", () => { els.volume.value = Math.round(player.volume * 100); paintRange(els.volume); });

/* ───── navigation ───── */

$$("[data-nav]").forEach((el) => el.addEventListener("click", () => { nowPlaying.hide(); navigate(el.dataset.nav); }));
$("#backBtn").addEventListener("click", goBack);
let searchTimer = 0;
$("#searchInput").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  const query = event.target.value;
  searchTimer = setTimeout(() => navigate("search", { query }, { replace: currentView()?.name === "search" }), 300);
});
$("#searchInput").addEventListener("focus", () => { nowPlaying.hide(); if (currentView()?.name !== "search") navigate("search", { query: $("#searchInput").value }); });

/* ───── keyboard ───── */

document.addEventListener("keydown", (event) => {
  const typing = event.target.matches?.("input:not([type=range]):not([type=checkbox]), textarea");
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#searchInput").focus(); $("#searchInput").select(); return; }
  if ((event.metaKey || event.ctrlKey) && event.key === "[") { goBack(); return; }
  if (typing || event.metaKey || event.ctrlKey || $("#modal").open) return;
  switch (event.code) {
    case "Space": event.preventDefault(); player.toggle(); break;
    case "ArrowRight": if (event.shiftKey) player.next(); else player.engine.seek(player.engine.currentTime + 5); break;
    case "ArrowLeft": if (event.shiftKey) player.prev(); else player.engine.seek(player.engine.currentTime - 5); break;
    case "KeyD": player.toggleSpatial(); break;
    case "KeyL": if (player.track) toggleFavorite(player.track).then(renderBar); break;
    case "KeyF": if (player.track) nowPlaying.setImmersive(!nowPlaying.immersive); break;
    case "Escape":
      if (nowPlaying.immersive) nowPlaying.setImmersive(false);
      else if (nowPlaying.drawerOpen) nowPlaying.closeDrawer();
      else nowPlaying.hide();
      break;
    default: break;
  }
});

/* ───── backend events ───── */

listen("track-changed", ({ id, track }) => {
  if (track) library.set(id, track);
  const row = $(`.trow[data-id="${CSS.escape(id)}"]`);
  if (row) import("./ui.js").then(({ stateBadge }) => { const cell = row.querySelector(".tstate"); if (cell) cell.innerHTML = stateBadge(track); });
  updatePrep();
});
listen("prep-progress", () => updatePrep());
listen("accounts-changed", () => { if (currentView()?.name === "settings") navigate("settings", {}, { replace: true }); });
listen("yandex-signed-in", () => syncLikes());
document.addEventListener("library-changed", () => { updatePrep(); renderBar(); });

/** Brings new Yandex likes into favourites; speaks only when there is something new. */
export async function syncLikes({ manual = false } = {}) {
  try {
    const { added, total } = await api.importYandexLikes();
    if (added) {
      library.clear();
      toast(`+${added} ${plural(added, "трек", "трека", "треков")} из Яндекс Музыки`);
      if (["favorites", "home"].includes(currentView()?.name)) navigate(currentView().name, currentView().params, { replace: true });
    } else if (manual) toast(`Новых лайков нет · всего ${total}`);
    updatePrep();
  } catch (error) {
    if (manual) toast(`Яндекс: ${error}`, { error: true });
  }
}

let prepTimer = 0;
function updatePrep() {
  clearTimeout(prepTimer);
  prepTimer = setTimeout(async () => {
    const prep = await api.prepStatus().catch(() => null);
    if (!prep) return;
    const share = prep.total ? prep.ready / prep.total : 0;
    $(".prep-fill").style.strokeDashoffset = String(94.2 * (1 - share));
    $("#prepSub").textContent = prep.total ? `${prep.ready} из ${prep.total}` : "пусто";
    $("#prepCard").classList.toggle("busy", prep.pending > 0);
    $("#prepCard").title = prep.pending ? `Готовлю ещё ${prep.pending}. Стемы делаются, когда музыка на паузе.` : "Всё готово";
  }, 250);
}

/* ───── background analysis of ready tracks ───── */

let analyzing = false;
async function analyzeIdle() {
  if (analyzing || player.playing) return;
  const kept = await api.kept().catch(() => []);
  const todo = kept.find((t) => t.state === "ready" && t.stems && !t.analysis?.stems);
  if (!todo) return;
  analyzing = true;
  try { await analyzeInBackground(todo); } catch (error) { console.warn("background analysis", error); } finally { analyzing = false; }
}
setInterval(analyzeIdle, 15000);

/* ───── system media: Now Playing, media keys, headphone buttons ───── */

function pushMedia() {
  const track = player.track;
  api.mediaUpdate({
    track: track ? { title: track.title, artist: artistNames(track), album: track.album || null, cover: track.cover || null, duration: player.engine.duration || track.duration || 0 } : null,
    playing: player.playing,
    position: Math.floor(player.engine.currentTime),
  });
}
player.on("track", pushMedia);
player.on("state", pushMedia);
// The OS extrapolates the position itself; a refresh every few seconds only corrects drift.
setInterval(() => { if (player.playing) pushMedia(); }, 5000);

listen("media-key", ({ action, seconds }) => {
  const engine = player.engine;
  switch (action) {
    case "play": if (!player.playing) player.toggle(); break;
    case "pause": if (player.playing) player.toggle(); break;
    case "toggle": player.toggle(); break;
    case "next": player.next(); break;
    case "previous": player.prev(); break;
    case "seekBy": engine.seek(engine.currentTime + seconds); pushMedia(); break;
    case "seekTo": engine.seek(seconds); pushMedia(); break;
    default: break;
  }
});

/* ───── frame loop ───── */

let lastSave = 0;
function frame(now) {
  const engine = player.engine;
  engine.tick();
  const duration = engine.duration || player.track?.duration || 0;
  const time = engine.currentTime;
  if (!nowPlaying.open && player.track) {
    els.cur.textContent = fmtTime(time); els.dur.textContent = fmtTime(duration);
    if (!els.seek.matches(":active") && duration) { els.seek.value = Math.round(time / duration * 1000); paintRange(els.seek); }
  }
  if (engine.playing && duration && time >= duration - 0.05) player.next(true);
  if (engine.playing && now - lastSave > 5000) { lastSave = now; player.saveSession(); }
  drawFrame(now);
  requestAnimationFrame(frame);
}

setInterval(() => {
  if (!document.hidden) return;
  const engine = player.engine;
  engine.tick();
  if (engine.playing && engine.duration && engine.currentTime >= engine.duration - 0.05) player.next(true);
}, 250);
window.addEventListener("beforeunload", () => player.saveSession());

/* ───── start ───── */

(async () => {
  const shown = performance.now();
  await player.restore();
  els.volume.value = Math.round(player.volume * 100); paintRange(els.volume); syncVolume(); paintRange(els.seek);
  await refreshPlaylists();
  renderSidePlaylists();
  navigate("home");
  updatePrep();
  requestAnimationFrame(frame);
  // The splash stays a moment so it reads as a logo, not a flicker.
  setTimeout(() => $("#splash")?.classList.add("out"), Math.max(0, 1000 - (performance.now() - shown)));
  setTimeout(() => $("#splash")?.remove(), 1800);
  api.accounts().then((accounts) => { if (accounts.yandex?.connected) syncLikes(); }).catch(() => {});
  await player.restoreSession().catch(() => {});
  renderBar();
})();

window.nearfield = { player, navigate, api, syncLikes };
