import { api, listen } from "./api.js";
import { drawFrame, nowPlaying, openQueueTab, paintRange } from "./nowplaying.js";
import { analyzeInBackground, player } from "./player.js";
import { library, refreshPlaylists, toggleFavorite } from "./tracks.js";
import { $, $$, artistNames, fmtTime, toast } from "./ui.js";
import { currentView, goBack, navigate, renderSidePlaylists } from "./views.js";

const els = {
  play: $("#playBtn"), prev: $("#prevBtn"), next: $("#nextBtn"), shuffle: $("#shuffleBtn"), repeat: $("#repeatBtn"),
  seek: $("#seek"), cur: $("#curTime"), dur: $("#durTime"), title: $("#pbTitle"), artist: $("#pbArtist"),
  coverImg: $("#pbCoverImg"), heart: $("#pbHeart"), status: $("#pbStatus"), volume: $("#volume"),
  d3: $("#pb3d"), slowed: $("#pbSlowed"), reverb: $("#pbReverb"), bar: $("#playerbar"),
};
nowPlaying.setNavigator(navigate);

/* ───── player bar ───── */

function renderBar() {
  const track = player.track;
  els.bar.classList.toggle("idle", !track);
  if (track) {
    els.title.textContent = track.title;
    els.artist.textContent = artistNames(track);
    els.coverImg.src = track.cover || "";
    els.coverImg.hidden = !track.cover;
    els.heart.classList.toggle("on", Boolean(library.get(track.id)?.favorite));
  }
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
  els.slowed.classList.toggle("on", s.rate < 1);
  els.reverb.classList.toggle("on", s.fxReverb);
  $$(".trow").forEach((row) => row.classList.toggle("playing", row.dataset.id === player.track?.id));
  $$(".trow.playing").forEach((row) => row.classList.toggle("paused", !player.playing));
}

player.on("track", renderBar);
player.on("state", renderState);
player.on("loading", renderState);
player.on("settings", renderState);
player.on("queue", renderState);
player.on("status", ({ text }) => { els.status.textContent = text ? text.toLowerCase() : ""; });
player.on("error", ({ message }) => toast(`Не удалось включить: ${message}`, { error: true }));
player.on("needsGesture", () => toast("Нажми ▶, чтобы продолжить"));
player.on("moodExhausted", async () => {
  const { startMood } = await import("./views.js");
  startMood(player.context.id);
});

els.play.addEventListener("click", () => player.toggle());
els.prev.addEventListener("click", () => player.prev());
els.next.addEventListener("click", () => player.next());
els.shuffle.addEventListener("click", () => player.setShuffle(!player.shuffle));
els.repeat.addEventListener("click", () => player.cycleRepeat());
els.d3.addEventListener("click", () => player.toggleSpatial());
els.slowed.addEventListener("click", () => player.toggleSlowed());
els.reverb.addEventListener("click", () => player.toggleReverb());
$("#queueBtn").addEventListener("click", openQueueTab);
$("#pbCover").addEventListener("click", () => player.track && nowPlaying.toggle());
$(".pb-meta").addEventListener("click", () => player.track && nowPlaying.toggle());
els.heart.addEventListener("click", async () => { if (player.track) { await toggleFavorite(player.track); renderBar(); } });
els.seek.addEventListener("input", () => {
  const duration = player.engine.duration || player.track?.duration || 0;
  player.engine.seek(Number(els.seek.value) / 1000 * duration);
  paintRange(els.seek);
});
els.volume.addEventListener("input", () => { player.setVolume(Number(els.volume.value) / 100); paintRange(els.volume); });

/* ───── navigation ───── */

$$("[data-nav]").forEach((el) => el.addEventListener("click", () => { nowPlaying.hide(); navigate(el.dataset.nav); }));
$("#backBtn").addEventListener("click", goBack);
let searchTimer = 0;
$("#searchInput").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  const query = event.target.value;
  searchTimer = setTimeout(() => {
    nowPlaying.hide();
    navigate("search", { query }, { replace: currentView()?.name === "search" });
  }, 320);
});
$("#searchInput").addEventListener("focus", () => { if (currentView()?.name !== "search") { nowPlaying.hide(); navigate("search", { query: $("#searchInput").value }); } });

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
    case "KeyS": player.toggleSlowed(); break;
    case "KeyR": player.toggleReverb(); break;
    case "KeyL": if (player.track) toggleFavorite(player.track).then(renderBar); break;
    case "KeyF": if (player.track) nowPlaying.setImmersive(!nowPlaying.immersive); break;
    case "Escape": if (nowPlaying.immersive) nowPlaying.setImmersive(false); else if (nowPlaying.open) nowPlaying.hide(); break;
    default: break;
  }
});

/* ───── backend events ───── */

listen("track-changed", ({ id, track }) => {
  if (track) library.set(id, track);
  const row = $(`.trow[data-id="${CSS.escape(id)}"]`);
  if (row) import("./ui.js").then(({ stateBadge }) => { const cell = row.querySelector(".tstate"); if (cell) cell.innerHTML = stateBadge(track); });
  if (track?.state === "ready" && player.track?.id === id && !player.playing) toast(`«${track.title}» теперь в полном 3D`);
  updatePrep();
});
listen("prep-progress", () => updatePrep());
listen("accounts-changed", () => {
  toast("Аккаунт обновлён");
  if (currentView()?.name === "settings") navigate("settings", {}, { replace: true });
});
document.addEventListener("library-changed", () => { updatePrep(); renderBar(); });

let prepTimer = 0;
function updatePrep() {
  clearTimeout(prepTimer);
  prepTimer = setTimeout(async () => {
    const prep = await api.prepStatus().catch(() => null);
    if (!prep) return;
    const share = prep.total ? prep.ready / prep.total : 0;
    $(".prep-fill").style.strokeDashoffset = String(94.2 * (1 - share));
    $("#prepSub").textContent = prep.total
      ? prep.pending ? `${prep.ready}/${prep.total} в 3D · готовлю ещё ${prep.pending}${player.playing ? " (после паузы)" : ""}` : `${prep.ready}/${prep.total} готовы в 3D`
      : "лайкни треки — подготовлю";
    $("#prepCard").classList.toggle("busy", prep.pending > 0);
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

/* ───── frame loop ───── */

function frame(now) {
  const engine = player.engine;
  engine.tick();
  const duration = engine.duration || player.track?.duration || 0;
  const time = engine.currentTime;
  els.cur.textContent = fmtTime(time); els.dur.textContent = fmtTime(duration);
  if (!els.seek.matches(":active") && duration) { els.seek.value = Math.round(time / duration * 1000); paintRange(els.seek); }
  if (engine.playing && duration && time >= duration - 0.05) player.next(true);
  drawFrame(now);
  requestAnimationFrame(frame);
}

// Animation frames stop when the window is hidden; keep motion scheduled and the queue advancing.
setInterval(() => {
  if (!document.hidden) return;
  const engine = player.engine;
  engine.tick();
  if (engine.playing && engine.duration && engine.currentTime >= engine.duration - 0.05) player.next(true);
}, 250);

/* ───── start ───── */

(async () => {
  await player.restore();
  els.volume.value = Math.round(player.volume * 100); paintRange(els.volume); paintRange(els.seek);
  renderBar();
  await refreshPlaylists();
  renderSidePlaylists();
  navigate("home");
  updatePrep();
  requestAnimationFrame(frame);
})();

window.nearfield = { player, navigate, api };
