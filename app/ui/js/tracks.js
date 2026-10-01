/* Track lists: rows, library state, favourites and the "⋯" menu. Used by every view. */

import { api } from "./api.js";
import { player } from "./player.js";
import { $$, artistLinks, artistNames, cover, esc, fmtTime, ICON, openMenu, PROVIDERS, sourceBadges, stateBadge, toast } from "./ui.js";

/** Library rows by id: favourite flag and preparation state, kept fresh by backend events. */
export const library = new Map();
export const playlistsCache = { list: [] };
let navigate = () => {};
export function setNavigator(fn) { navigate = fn; }

export async function refreshPlaylists() {
  playlistsCache.list = await api.playlists().catch(() => []);
  document.dispatchEvent(new CustomEvent("playlists-changed"));
  return playlistsCache.list;
}

function row(track, index, options) {
  const item = library.get(track.id) || track;
  const fav = Boolean(item.favorite);
  const playing = player.track?.id === track.id;
  return `
    <div class="trow ${playing ? "playing" : ""}" data-index="${index}" data-id="${esc(track.id)}" ${options.reorder ? 'draggable="true"' : ""}>
      <span class="tnum">${options.reorder ? `<span class="grip">${ICON.grip}</span>` : ""}<span class="n">${index + 1}</span><span class="eq"><i></i><i></i><i></i></span><button class="tplay" data-act="play" title="Играть">${ICON.play}</button></span>
      ${cover(track.cover, "sm")}
      <span class="tmain">
        <b>${esc(track.title)}${track.explicit ? ' <span class="e">E</span>' : ""}</b>
        <small>${artistLinks(track)}</small>
      </span>
      ${options.album === false ? "" : `<span class="talbum">${esc(track.album || "")}</span>`}
      <span class="tsrc">${sourceBadges(track)}</span>
      <span class="tstate">${stateBadge(library.get(track.id))}</span>
      <button class="icon-btn heart ${fav ? "on" : ""}" data-act="fav" title="${fav ? "Убрать из избранного" : "В избранное"}">${ICON.heart}</button>
      <span class="tdur">${fmtTime(track.duration)}</span>
      <button class="icon-btn" data-act="more" title="Ещё">${ICON.more}</button>
    </div>`;
}

/**
 * Renders a list into `container`. options: { context, album, reorder, playlistId, onReorder, empty }
 * Returns a refresh function.
 */
export function renderTracks(container, tracks, options = {}) {
  container.classList.add("tracks");
  const draw = () => {
    container.innerHTML = tracks.length ? tracks.map((t, i) => row(t, i, options)).join("") : `<div class="empty-note">${options.empty || "Пусто"}</div>`;
  };
  draw();
  container.__tracks = tracks;
  container.__options = options;
  if (!container.__wired) wire(container);
  loadStatus(tracks).then(draw);
  return draw;
}

async function loadStatus(tracks) {
  const ids = tracks.map((t) => t.id).filter((id) => !library.has(id));
  if (!ids.length) return;
  const status = await api.status(ids).catch(() => ({}));
  Object.entries(status).forEach(([id, item]) => library.set(id, item));
}

function wire(container) {
  container.__wired = true;
  const trackAt = (el) => {
    const rowEl = el.closest(".trow");
    return rowEl ? { rowEl, index: Number(rowEl.dataset.index), track: container.__tracks[Number(rowEl.dataset.index)] } : null;
  };
  container.addEventListener("click", (event) => {
    const artist = event.target.closest("[data-artist]");
    if (artist) { event.stopPropagation(); navigate("artist", { id: artist.dataset.artist }); return; }
    const hit = trackAt(event.target);
    if (!hit) return;
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "fav") { event.stopPropagation(); toggleFavorite(hit.track); return; }
    if (act === "more") { event.stopPropagation(); trackMenu(event, hit.track, container.__options); return; }
    if (act === "play" || event.detail >= 2 || container.__options.singleClick !== false) playFrom(container, hit.index);
  });
  container.addEventListener("contextmenu", (event) => {
    const hit = trackAt(event.target);
    if (hit) trackMenu(event, hit.track, container.__options);
  });
  // Drag to reorder (playlists).
  let dragFrom = -1;
  container.addEventListener("dragstart", (event) => { const hit = trackAt(event.target); if (hit) { dragFrom = hit.index; hit.rowEl.classList.add("dragging"); } });
  container.addEventListener("dragover", (event) => { if (dragFrom >= 0) { event.preventDefault(); const hit = trackAt(event.target); $$(".trow", container).forEach((r) => r.classList.toggle("drop", r === hit?.rowEl)); } });
  container.addEventListener("dragend", () => { dragFrom = -1; $$(".trow", container).forEach((r) => r.classList.remove("dragging", "drop")); });
  container.addEventListener("drop", (event) => {
    const hit = trackAt(event.target);
    if (!hit || dragFrom < 0 || hit.index === dragFrom) return;
    const list = container.__tracks;
    const [moved] = list.splice(dragFrom, 1);
    list.splice(hit.index, 0, moved);
    container.__options.onReorder?.(list);
    renderTracks(container, list, container.__options);
  });
}

function playFrom(container, index) {
  const tracks = container.__tracks;
  const track = tracks[index];
  if (player.track?.id === track.id && player.index >= 0) { player.toggle(); return; }
  player.playList(tracks, index, container.__options.context || null);
}

export async function toggleFavorite(track) {
  const current = library.get(track.id);
  const favorite = !current?.favorite;
  await api.setFavorite(track, favorite);
  library.set(track.id, { ...(current || track), favorite, state: current?.state || "new" });
  document.dispatchEvent(new CustomEvent("library-changed", { detail: { id: track.id } }));
  toast(favorite ? "Добавлено в избранное" : "Удалено из избранного");
}

export function trackMenu(event, track, options = {}) {
  const links = (track.sources || []).filter((s) => s.url || s.provider === "yandex");
  const items = [
    { label: "Играть следующим", icon: ICON.play, run: () => { player.addNext(track); toast("Будет следующим"); } },
    { label: "Добавить в очередь", icon: ICON.plus, run: () => { player.addToQueue([track]); toast("Добавлено в очередь"); } },
    {
      label: "Добавить в плейлист", icon: ICON.plus, sub: () => [
        { label: "Новый плейлист…", icon: ICON.plus, run: () => newPlaylist([track]) },
        ...(playlistsCache.list.length ? ["-"] : []),
        ...playlistsCache.list.map((p) => ({ label: p.name, run: async () => { await api.playlistAdd(p.id, track); refreshPlaylists(); toast(`Добавлено в «${p.name}»`); } })),
      ],
    },
    { label: library.get(track.id)?.favorite ? "Убрать из избранного" : "В избранное", icon: ICON.heart, run: () => toggleFavorite(track) },
  ];
  if (options.playlistId) items.push({ label: "Убрать из плейлиста", icon: ICON.trash, danger: true, run: () => options.onRemove?.(track) });
  const artist = track.artists?.find((a) => a.id);
  if (artist) items.push("-", { label: `Артист: ${artist.name}`, run: () => navigate("artist", { id: artist.id }) });
  if (links.length) {
    items.push("-");
    links.forEach((s) => {
      const url = s.url || `https://music.yandex.ru/track/${s.id.split(":")[0]}`;
      items.push({ label: `Открыть в ${PROVIDERS[s.provider]?.label || s.provider}`, icon: ICON.ext, run: () => window.open(url, "_blank") });
    });
  }
  openMenu(event, items);
}

export async function newPlaylist(tracks = []) {
  const { ask } = await import("./ui.js");
  const name = await ask("Новый плейлист", { placeholder: "Название", confirm: "Создать" });
  if (!name) return null;
  const id = await api.playlistCreate(name, tracks);
  await refreshPlaylists();
  toast(`Плейлист «${name}» создан`);
  return id;
}

export function trackTitle(track) { return `${artistNames(track)} — ${track.title}`; }
