/* Pages: home, search, artist, album, favourites, playlist, wave, settings. */

import { api, listen } from "./api.js";
import { MOODS } from "./moods.js";
import { EQ_PRESETS, player } from "./player.js";
import { library, newPlaylist, playlistsCache, refreshPlaylists, renderTracks, setNavigator } from "./tracks.js";
import { $, $$, artistNames, ask, confirmBox, cover, esc, fmtCount, fmtTime, ICON, plural, PROVIDERS, toast } from "./ui.js";
import { ACTIVITIES, CHARACTER, DEFAULT_WAVE, describe, LANGUAGE, loadWave, MOOD, startWave } from "./wave.js";
import { USER_EQ_BANDS } from "../engine/graph.js";

const view = $("#view");
const stack = [];
let current = null;
let searchToken = 0;

export function navigate(name, params = {}, { replace = false, back = false } = {}) {
  if (current && !replace && !back) stack.push(current);
  current = { name, params };
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.nav === name));
  $$(".side-playlist").forEach((item) => item.classList.toggle("active", name === "playlist" && Number(item.dataset.id) === params.id));
  $("#backBtn").disabled = !stack.length;
  if (name !== "search") $("#searchInput").value = "";
  view.scrollTop = 0;
  view.classList.remove("in"); void view.offsetWidth; view.classList.add("in");
  (PAGES[name] || PAGES.home)(params);
}
setNavigator(navigate);

export function goBack() {
  const previous = stack.pop();
  if (previous) navigate(previous.name, previous.params, { back: true });
}

export const currentView = () => current;

const LIKED_ART = (size) => `<img class="cover ${size} liked-art" src="img/liked@512.png" alt="" />`;
const playBtn = (label = "Слушать") => `<button class="btn primary big" data-act="play">${ICON.play}<span>${label}</span></button>`;
const section = (title, body, extra = "") => `<section class="sec"><div class="sec-head"><h2>${title}</h2>${extra}</div>${body}</section>`;

/* ───── home ───── */

async function home() {
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Доброй ночи" : hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер";
  view.innerHTML = `
    <div class="page">
      <h1 class="greet">${greeting}</h1>
      <div class="quick" id="quick"></div>
      <div id="homeWave"></div>
      <div id="homeRecent"></div>
      <div id="homeLists"></div>
    </div>`;
  const [history, favorites] = await Promise.all([api.history().catch(() => []), api.favorites().catch(() => [])]);
  if (current?.name !== "home") return;
  history.concat(favorites).forEach((t) => library.set(t.id, t));
  const lists = playlistsCache.list;
  // Spotify-style quick tiles: favourites, wave, playlists.
  const quick = [
    `<button class="qtile" data-goto="favorites">${LIKED_ART("qt")}<b>Избранное</b><span class="qplay">${ICON.play}</span></button>`,
    `<button class="qtile" data-goto="wave"><span class="cover qt wave-art"><i></i></span><b>Моя волна</b><span class="qplay">${ICON.play}</span></button>`,
    ...lists.slice(0, 4).map((p) => `<button class="qtile" data-playlist="${p.id}">${collage(p.covers, "qt")}<b>${esc(p.name)}</b></button>`),
  ];
  $("#quick").innerHTML = quick.join("");
  $$("[data-goto]", $("#quick")).forEach((el) => el.addEventListener("click", (e) => {
    if (e.target.closest(".qplay")) {
      e.stopPropagation();
      if (el.dataset.goto === "favorites") player.playList(favorites, 0, { type: "favorites", label: "Избранное" });
      else loadWave().then((state) => startWave(state).catch((err) => toast(String(err.message || err), { error: true })));
      return;
    }
    navigate(el.dataset.goto);
  }));
  $$("[data-playlist]", $("#quick")).forEach((el) => el.addEventListener("click", () => navigate("playlist", { id: Number(el.dataset.playlist) })));
  if (history.length) {
    $("#homeRecent").innerHTML = section("Недавнее", `<div class="tiles">${history.slice(0, 12).map(tile).join("")}</div>`);
    wireTiles($("#homeRecent"), history.slice(0, 12), { type: "history", label: "Недавнее" });
  }
  if (favorites.length) {
    $("#homeLists").innerHTML = section("Из избранного", `<div id="homeFavList"></div>`, `<button class="link more" data-goto="favorites">Все</button>`);
    renderTracks($("#homeFavList"), favorites.slice(0, 5), { context: { type: "favorites", label: "Избранное" } });
    $$("[data-goto]", $("#homeLists")).forEach((el) => el.addEventListener("click", () => navigate(el.dataset.goto)));
  }
}

function tile(track, index) {
  return `<button class="tile" data-index="${index}">${cover(track.cover, "lg")}<span class="tile-play">${ICON.play}</span><b>${esc(track.title)}</b><small>${esc(artistNames(track))}</small></button>`;
}

function wireTiles(root, tracks, context) {
  $$(".tile", root).forEach((el) => el.addEventListener("click", () => player.playList(tracks, Number(el.dataset.index), context)));
}

function collage(covers, size = "lg") {
  if (covers.length >= 4) return `<div class="collage ${size}">${covers.slice(0, 4).map((c) => `<img src="${esc(c)}" alt="" />`).join("")}</div>`;
  return cover(covers[0], size);
}

/* ───── search ───── */

async function search({ query = "" }) {
  const input = $("#searchInput");
  if (input.value !== query) input.value = query;
  if (!query.trim()) {
    view.innerHTML = `<div class="page"><h1>Поиск</h1>${section("Настроение", `<div class="mood-grid">${MOODS.map((m) => moodCard(m)).join("")}</div>`)}</div>`;
    wireMoodCards(view);
    input.focus();
    return;
  }
  const token = ++searchToken;
  view.innerHTML = `<div class="page"><div class="skeleton-list">${"<div></div>".repeat(8)}</div></div>`;
  const result = await api.search(query).catch((error) => ({ tracks: [], artists: [], errors: [String(error)] }));
  if (token !== searchToken) return;
  const [top, ...rest] = result.tracks;
  const errors = result.errors.length ? `<div class="note warn">${result.errors.map(esc).join("<br>")}</div>` : "";
  if (!top) {
    view.innerHTML = `<div class="page">${errors}<div class="empty-big"><b>Ничего не нашлось</b></div></div>`;
    return;
  }
  view.innerHTML = `
    <div class="page">
      ${errors}
      <div class="search-top">
        <div class="best">
          <h2>Лучшее совпадение</h2>
          <div class="best-card" id="bestCard">
            ${cover(top.cover, "xl")}
            <div><b>${esc(top.title)}</b><span>${esc(artistNames(top))}${top.year ? ` · ${top.year}` : ""}</span></div>
            <button class="play-fab" data-act="play">${ICON.play}</button>
          </div>
        </div>
        <div class="best-list"><h2>Треки</h2><div id="topTracks"></div></div>
      </div>
      ${result.artists.length ? section("Артисты", `<div class="artist-row">${result.artists.slice(0, 8).map(artistBubble).join("")}</div>`) : ""}
      ${rest.length > 4 ? section("Ещё треки", `<div id="moreTracks"></div>`) : ""}
    </div>`;
  const context = { type: "search", label: query };
  $("#bestCard").addEventListener("click", () => player.playList(result.tracks, 0, context));
  renderTracks($("#topTracks"), result.tracks.slice(0, 5), { context, album: false });
  if (rest.length > 4) renderTracks($("#moreTracks"), result.tracks.slice(5), { context });
  wireArtists(view);
}

function artistBubble(a) {
  return `<button class="artist-bubble" data-artist="${esc(a.id)}">${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" />` : `<span class="ph">${esc(a.name[0] || "?")}</span>`}<b>${esc(a.name)}</b><small>Артист</small></button>`;
}

function wireArtists(root) {
  $$(".artist-bubble", root).forEach((el) => el.addEventListener("click", () => navigate("artist", { id: el.dataset.artist })));
}

/* ───── artist ───── */

async function artist({ id }) {
  view.innerHTML = `<div class="artist-hero loading"></div><div class="page"><div class="skeleton-list">${"<div></div>".repeat(6)}</div></div>`;
  let page;
  try {
    page = await api.artist(id);
  } catch (error) {
    view.innerHTML = `<div class="page"><div class="empty-big"><b>Не удалось открыть</b><span>${esc(error)}</span></div></div>`;
    return;
  }
  if (current?.params?.id !== id) return;
  const a = page.artist;
  const hero = page.images[0] || a.image;
  const stats = page.listeners ? `${fmtCount(page.listeners)} слушателей за месяц` : page.likes ? `${fmtCount(page.likes)} подписчиков` : "";
  const context = { type: "artist", label: a.name, id };
  view.innerHTML = `
    <div class="artist-hero" style="--hero:url('${esc(hero || "")}')">
      <div class="hero-shade"></div>
      <div class="hero-content">
        <div>
          <span class="eyebrow">Артист</span>
          <h1>${esc(a.name)}</h1>
          <p>${stats}</p>
        </div>
      </div>
    </div>
    <div class="page">
      <div class="action-row">${playBtn()}<button class="icon-btn big" data-act="shuffle" title="Перемешать">${ICON.shuffle}</button></div>
      ${section("Популярное", `<div id="artistTracks"></div>`)}
      ${page.albums.length ? section("Альбомы", `<div class="tiles">${page.albums.map((al) => `<button class="tile" data-album="${esc(al.id)}" data-title="${esc(al.title)}" data-cover="${esc(al.cover || "")}">${cover(al.cover, "lg")}<b>${esc(al.title)}</b><small>${al.year || ""}${al.kind === "single" ? " · Сингл" : ""}</small></button>`).join("")}</div>`) : ""}
      ${page.similar.length ? section("Похожие", `<div class="artist-row">${page.similar.slice(0, 10).map(artistBubble).join("")}</div>`) : ""}
      ${page.description ? section("Об артисте", `<div class="about"><p>${esc(page.description)}</p>${a.genres.length ? `<div class="chips">${a.genres.slice(0, 4).map((g) => `<span class="chip">${esc(g)}</span>`).join("")}</div>` : ""}</div>`) : ""}
      ${page.links.length ? `<div class="links">${dedupeLinks(page.links).map((l) => `<a href="${esc(l.url)}" target="_blank" class="chip link-chip">${ICON.ext}${esc(l.title)}</a>`).join("")}</div>` : ""}
    </div>`;
  renderTracks($("#artistTracks"), page.tracks, { context });
  $('[data-act="play"]', view).addEventListener("click", () => player.playList(page.tracks, 0, context));
  $('[data-act="shuffle"]', view).addEventListener("click", () => { player.setShuffle(true); player.playList(page.tracks, Math.floor(Math.random() * page.tracks.length), context); });
  $$("[data-album]", view).forEach((el) => el.addEventListener("click", () => navigate("album", { id: el.dataset.album, title: el.dataset.title, cover: el.dataset.cover, artist: a.name })));
  wireArtists(view);
}

function dedupeLinks(links) {
  const seen = new Set();
  return links.filter((l) => !seen.has(l.url) && seen.add(l.url));
}

/* ───── lists (album, favourites, playlist) ───── */

function listHeader({ kind, title, sub, art }) {
  return `<header class="list-head">${art}<div><span class="eyebrow">${kind}</span><h1>${esc(title)}</h1><p class="list-sub">${esc(sub || "")}</p></div></header>`;
}

function actionRow(extra = "") {
  return `<div class="action-row">${playBtn()}<button class="icon-btn big" data-act="shuffle" title="Перемешать">${ICON.shuffle}</button>${extra}</div>`;
}

function wireListActions(tracks, context, { title } = {}) {
  $('[data-act="play"]', view)?.addEventListener("click", () => tracks.length && player.playList(tracks, 0, context));
  $('[data-act="shuffle"]', view)?.addEventListener("click", () => { if (!tracks.length) return; player.setShuffle(true); player.playList(tracks, Math.floor(Math.random() * tracks.length), context); });
  $('[data-act="saveas"]', view)?.addEventListener("click", async () => {
    const id = await api.playlistCreate(title, tracks);
    await refreshPlaylists();
    toast(`Плейлист «${title}» сохранён`);
    navigate("playlist", { id });
  });
}

const summary = (tracks) => `${tracks.length} ${plural(tracks.length, "трек", "трека", "треков")}, ${fmtTime(tracks.reduce((s, t) => s + t.duration, 0))}`;

async function album({ id, title, cover: art, artist: artistName }) {
  view.innerHTML = `<div class="page">${listHeader({ kind: "Альбом", title, sub: artistName, art: cover(art, "hero") })}${actionRow(`<button class="icon-btn big" data-act="saveas" title="Сохранить как плейлист">${ICON.plus}</button>`)}<div id="albumTracks"><div class="skeleton-list">${"<div></div>".repeat(8)}</div></div></div>`;
  let tracks;
  try { tracks = await api.album(id); } catch (error) { $("#albumTracks").innerHTML = `<div class="empty-note">${esc(error)}</div>`; return; }
  const context = { type: "album", label: title, id };
  $(".list-sub", view).textContent = `${artistName} · ${summary(tracks)}`;
  renderTracks($("#albumTracks"), tracks, { context, album: false });
  wireListActions(tracks, context, { title });
}

async function favorites() {
  const tracks = await api.favorites().catch(() => []);
  tracks.forEach((t) => library.set(t.id, t));
  const accounts = await api.accounts().catch(() => ({}));
  view.innerHTML = `<div class="page">
    ${listHeader({ kind: "Плейлист", title: "Избранное", sub: summary(tracks), art: LIKED_ART("hero") })}
    ${actionRow(accounts.yandex?.connected ? `<button class="btn ghost" data-act="likes">Обновить из Яндекса</button>` : "")}
    <div id="favTracks"></div></div>`;
  const context = { type: "favorites", label: "Избранное" };
  renderTracks($("#favTracks"), tracks, { context, empty: "Пока пусто. Жми ♥ у трека." });
  wireListActions(tracks, context);
  $('[data-act="likes"]', view)?.addEventListener("click", () => window.nearfield.syncLikes({ manual: true }));
}

async function playlist({ id }) {
  await refreshPlaylists();
  const meta = playlistsCache.list.find((p) => p.id === id);
  if (!meta) { navigate("home", {}, { replace: true }); return; }
  const tracks = await api.playlistTracks(id).catch(() => []);
  tracks.forEach((t) => library.set(t.id, t));
  const context = { type: "playlist", label: meta.name, id };
  view.innerHTML = `<div class="page">
    ${listHeader({ kind: "Плейлист", title: meta.name, sub: summary(tracks), art: collage(meta.covers, "hero") })}
    ${actionRow(`<button class="icon-btn big" data-act="more" title="Ещё">${ICON.more}</button>`)}
    <div id="plTracks"></div></div>`;
  const redraw = renderTracks($("#plTracks"), tracks, {
    context, reorder: true, playlistId: id,
    empty: "Пусто. Добавляй треки через «⋯».",
    onReorder: (list) => api.playlistReorder(id, list.map((t) => t.id)),
    onRemove: async (track) => {
      await api.playlistRemove(id, track.id);
      tracks.splice(tracks.findIndex((t) => t.id === track.id), 1);
      redraw(); refreshPlaylists();
    },
  });
  wireListActions(tracks, context);
  $('[data-act="more"]', view).addEventListener("click", async (event) => {
    const { openMenu } = await import("./ui.js");
    openMenu(event, [
      { label: "Переименовать", icon: ICON.edit, run: async () => {
        const name = await ask("Название", { value: meta.name });
        if (name) { await api.playlistRename(id, name); await refreshPlaylists(); navigate("playlist", { id }, { replace: true }); }
      } },
      { label: "Удалить", icon: ICON.trash, danger: true, run: async () => {
        if (await confirmBox("Удалить плейлист?", `«${meta.name}» будет удалён.`)) { await api.playlistDelete(id); await refreshPlaylists(); navigate("home", {}, { replace: true }); }
      } },
    ]);
  });
}

/* ───── moods (quick cards in search) ───── */

function moodCard(mood) {
  return `<button class="mood-card" data-mood="${mood.id}" style="--a:${mood.colors[0]};--b:${mood.colors[1]}"><span class="mood-glow"></span><b>${mood.label}</b><span class="mood-play">${ICON.play}</span></button>`;
}

function wireMoodCards(root) {
  $$("[data-mood]", root).forEach((el) => el.addEventListener("click", () => startMood(el.dataset.mood, el)));
}

export async function startMood(id, el) {
  const { buildMoodQueue } = await import("./moods.js");
  const mood = MOODS.find((m) => m.id === id);
  el?.classList.add("loading");
  try {
    const { queue } = await buildMoodQueue(mood);
    if (!queue.length) { toast("Не нашёл подходящих треков", { error: true }); return; }
    await player.playList(queue, 0, { type: "mood", id, label: mood.label });
  } finally {
    el?.classList.remove("loading");
  }
}

/* ───── my wave ───── */

const SPARK = `<svg viewBox="0 0 48 48" class="wave-ico"><defs><linearGradient id="gS" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe27a"/><stop offset="1" stop-color="#f5a623"/></linearGradient></defs><path d="M24 3c1.8 10.6 5.8 16.6 21 21-15.2 4.4-19.2 10.4-21 21-1.8-10.6-5.8-16.6-21-21C18.2 19.6 22.2 13.6 24 3z" fill="url(#gS)"/></svg>`;
const BOLT = `<svg viewBox="0 0 48 48" class="wave-ico"><defs><linearGradient id="gB" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b6ff5c"/><stop offset="1" stop-color="#1fb85a"/></linearGradient></defs><path d="M29 2 8 27h13l-4 19 23-27H27z" fill="url(#gB)"/><path d="M29 2 8 27h4l17-22z" fill="#fff" opacity=".25"/></svg>`;
const CHAR_ICON = { favorite: `<img class="wave-ico" src="img/liked@512.png" alt="" />`, discover: SPARK, popular: BOLT };

async function wave() {
  const state = await loadWave();
  const render = () => {
    const pick = (group, id) => (group === "activity" ? state.activity === id : !state.activity && state[group] === id);
    view.innerHTML = `
      <div class="page wave-page">
        <div class="wave-hero">
          <div class="wave-orb ${player.context?.type === "wave" && player.playing ? "live" : ""}"><i></i><i></i><i></i></div>
          <div>
            <h1>Моя волна</h1>
            <p class="wave-sum">${JSON.stringify(state) === JSON.stringify(DEFAULT_WAVE) ? "Подбирается по тому, что ты слушаешь" : esc(describe(state))}</p>
            <div class="action-row">${playBtn(player.context?.type === "wave" ? "Новая волна" : "Слушать")}${JSON.stringify(state) !== JSON.stringify(DEFAULT_WAVE) ? `<button class="btn ghost" data-act="reset">Сбросить</button>` : ""}</div>
          </div>
        </div>
        <div class="wave-panel">
          <h3>По занятию</h3>
          <div class="wchips">${ACTIVITIES.map((a) => `<button class="wchip ${pick("activity", a.id) ? "active" : ""}" data-g="activity" data-v="${a.id}">${a.label}</button>`).join("")}</div>
          <h3>По характеру</h3>
          <div class="wcards">${CHARACTER.map((c) => `<button class="wcard ${pick("diversity", c.id) ? "active" : ""}" data-g="diversity" data-v="${c.id}">${CHAR_ICON[c.id]}<b>${c.label}</b></button>`).join("")}</div>
          <h3>По настроению</h3>
          <div class="wmoods">${MOOD.map((m) => `<button class="wmood ${pick("moodEnergy", m.id) ? "active" : ""}" data-g="moodEnergy" data-v="${m.id}"><span style="--a:${m.colors[0]};--b:${m.colors[1]}"></span><b>${m.label}</b></button>`).join("")}</div>
          <h3>По языку</h3>
          <div class="wchips">${LANGUAGE.map((l) => `<button class="wchip ${pick("language", l.id) ? "active" : ""}" data-g="language" data-v="${l.id}">${l.label}</button>`).join("")}</div>
        </div>
      </div>`;
    $$("[data-g]", view).forEach((el) => el.addEventListener("click", () => {
      const { g, v } = el.dataset;
      if (g === "activity") state.activity = state.activity === v ? null : v;
      else {
        state.activity = null;
        const fallback = DEFAULT_WAVE[g];
        state[g] = state[g] === v ? fallback : v;
      }
      render();
      go();
    }));
    $('[data-act="play"]', view).addEventListener("click", go);
    $('[data-act="reset"]', view)?.addEventListener("click", () => { Object.assign(state, DEFAULT_WAVE); render(); go(); });
  };
  const go = async () => {
    const button = $('[data-act="play"]', view);
    button?.classList.add("loading");
    try { await startWave({ ...state }); render(); } catch (error) { toast(String(error.message || error), { error: true }); } finally { button?.classList.remove("loading"); }
  };
  render();
}

/* ───── settings ───── */

async function settings({ focus } = {}) {
  view.innerHTML = `<div class="page narrow"><h1>Настройки</h1><div id="settingsBody"></div></div>`;
  const [accounts, prep] = await Promise.all([api.accounts().catch(() => ({})), api.prepStatus().catch(() => null)]);
  const ya = accounts.yandex || {};
  const s = player.settings;
  $("#settingsBody").innerHTML = `
    <h2 class="set-h">Звук</h2>
    <section class="card">
      <label class="switch-row first"><span>3D-звук</span><input type="checkbox" id="setSpatial" ${s.spatial ? "checked" : ""} /></label>
      <label class="switch-row"><span>Наушники<small>Выключи для колонок</small></span><input type="checkbox" id="setHeadphone" ${s.headphone ? "checked" : ""} /></label>
    </section>
    <section class="card" id="eqCard">
      <div class="card-head"><div><b>Эквалайзер</b></div><button class="switch ${player.eq.some((g) => g) ? "on" : ""}" id="eqOn" aria-label="Эквалайзер"></button></div>
      <div class="chips eq-presets">${EQ_PRESETS.map((p) => `<button class="chip" data-eq="${p.id}">${p.label}</button>`).join("")}</div>
      <div class="eq-bands">${USER_EQ_BANDS.map((f, i) => `<label><output>${fmtDb(player.eq[i])}</output><div class="eq-slot"><input type="range" min="-12" max="12" step="0.5" value="${player.eq[i]}" data-band="${i}" /></div><span>${f >= 1000 ? `${f / 1000}k` : f}</span></label>`).join("")}</div>
    </section>

    <h2 class="set-h">Сервисы</h2>
    <section class="card">
      <div class="card-head"><span class="src src-yandex big" style="--c:${PROVIDERS.yandex.color}">Я</span><div><b>Яндекс Музыка</b><small>${ya.connected ? `${esc(ya.login)}${ya.plus ? " · Плюс" : ""}` : "Полные треки, тексты, Моя волна"}</small></div>
      ${ya.connected ? `<button class="btn ghost" id="yaLikes">Забрать лайки</button><button class="btn ghost" id="yaOut">Выйти</button>` : `<button class="btn primary" id="yaIn">Войти</button>`}</div>
    </section>
    <section class="card">
      <div class="card-head"><span class="src src-soundcloud big" style="--c:${PROVIDERS.soundcloud.color}">SC</span><div><b>SoundCloud</b><small>Подключён</small></div></div>
    </section>
    <section class="card">
      <div class="card-head"><span class="src src-spotify big" style="--c:${PROVIDERS.spotify.color}">S</span><div><b>Spotify</b><small>${accounts.spotify?.configured ? "Подключён · только поиск" : "Только поиск, нужен ключ разработчика"}</small></div></div>
      <details><summary>Ключи</summary>
        <div class="form-row"><input id="spId" placeholder="Client ID" autocomplete="off" spellcheck="false" /><input id="spSecret" placeholder="Client Secret" type="password" autocomplete="off" /><button class="btn" id="spSave">Сохранить</button></div>
      </details>
    </section>

    <h2 class="set-h">3D-библиотека</h2>
    <section class="card">
      <div class="card-head"><span class="ai-dot ${prep?.ai ? "on" : ""}"></span><div><b>${prep ? `${prep.ready} из ${prep.total} готовы` : "—"}</b><small>${prep?.ai ? "Стемы готовятся, когда музыка на паузе" : "Разделение на стемы не установлено"}</small></div>
      ${prep?.ai ? "" : `<button class="btn primary" id="installAi">Установить · 1 ГБ</button>`}<button class="btn ghost" id="retry">Повторить ошибки</button></div>
      <p class="hint" id="aiProgress" hidden></p>
    </section>`;
  $("#yaIn")?.addEventListener("click", () => api.yandexLogin());
  $("#yaOut")?.addEventListener("click", async () => { await api.yandexLogout(); settings(); });
  $("#yaLikes")?.addEventListener("click", () => window.nearfield.syncLikes({ manual: true }));
  $("#spSave").addEventListener("click", async () => { await api.spotifyKeys($("#spId").value, $("#spSecret").value); toast("Сохранено"); settings(); });
  $("#retry").addEventListener("click", async () => { await api.retryFailed(); toast("Повторю"); });
  $("#installAi")?.addEventListener("click", async (e) => {
    const button = e.currentTarget; button.disabled = true; button.textContent = "Ставлю…";
    const progress = $("#aiProgress"); progress.hidden = false;
    const stop = await listen("ai-install", ({ text }) => { progress.textContent = text; });
    try { await api.installAi(); toast("Установлено"); settings(); }
    catch (error) { progress.textContent = String(error); button.disabled = false; button.textContent = "Повторить"; }
    finally { stop(); }
  });
  $("#setSpatial").addEventListener("change", (e) => player.setGlobal({ spatial: e.target.checked }));
  $("#setHeadphone").addEventListener("change", (e) => player.setGlobal({ headphone: e.target.checked }));
  wireEq();
  if (focus === "eq") $("#eqCard").scrollIntoView({ block: "center" });
}

// Fill grows from the 0 dB centre line up or down.
function paintEq(input) {
  const v = Number(input.value); const mid = 50; const at = 50 + (v / 12) * 50;
  const [a, b] = at >= mid ? [mid, at] : [at, mid];
  input.style.background = `linear-gradient(90deg, rgba(255,255,255,.16) ${a}%, var(--accent) ${a}%, var(--accent) ${b}%, rgba(255,255,255,.16) ${b}%)`;
}

const fmtDb = (g) => (g > 0 ? `+${g}` : `${g}`);

function wireEq() {
  const inputs = $$(".eq-bands input", view);
  const sync = () => {
    inputs.forEach((input, i) => { input.value = player.eq[i]; input.closest("label").querySelector("output").textContent = fmtDb(player.eq[i]); paintEq(input); });
    $("#eqOn").classList.toggle("on", player.eq.some((g) => g));
    $$("[data-eq]", view).forEach((b) => b.classList.toggle("active", EQ_PRESETS.find((p) => p.id === b.dataset.eq).gains.every((g, i) => g === player.eq[i])));
  };
  inputs.forEach((input) => input.addEventListener("input", () => {
    const gains = player.eq.slice(); gains[Number(input.dataset.band)] = Number(input.value);
    player.setEq(gains); sync();
  }));
  $$("[data-eq]", view).forEach((b) => b.addEventListener("click", () => { player.setEq(EQ_PRESETS.find((p) => p.id === b.dataset.eq).gains); sync(); }));
  $("#eqOn").addEventListener("click", () => { player.setEq(player.eq.some((g) => g) ? EQ_PRESETS[0].gains : EQ_PRESETS[1].gains); sync(); });
  sync();
}

const PAGES = { home, search, artist, album, favorites, playlist, wave, mood: wave, settings };

/* ───── sidebar playlists ───── */

export function renderSidePlaylists() {
  const root = $("#sidePlaylists");
  const lists = playlistsCache.list;
  root.innerHTML = `<button class="side-playlist ${current?.name === "favorites" ? "active" : ""}" data-fav>${LIKED_ART("xs")}<span><b>Избранное</b><small>Плейлист</small></span></button>`
    + lists.map((p) => `<button class="side-playlist ${current?.name === "playlist" && current.params.id === p.id ? "active" : ""}" data-id="${p.id}">${collage(p.covers, "xs")}<span><b>${esc(p.name)}</b><small>${p.count} ${plural(p.count, "трек", "трека", "треков")}</small></span></button>`).join("");
  $("[data-fav]", root).addEventListener("click", () => navigate("favorites"));
  $$(".side-playlist[data-id]", root).forEach((el) => el.addEventListener("click", () => navigate("playlist", { id: Number(el.dataset.id) })));
}

document.addEventListener("playlists-changed", renderSidePlaylists);
$("#newPlaylist").addEventListener("click", async () => {
  const id = await newPlaylist();
  if (id) navigate("playlist", { id });
});

