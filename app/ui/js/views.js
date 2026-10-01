/* Pages: home, search, artist, album, favourites, playlist, mood, settings. */

import { api } from "./api.js";
import { buildMoodQueue, MOODS } from "./moods.js";
import { player } from "./player.js";
import { library, newPlaylist, playlistsCache, refreshPlaylists, renderTracks, setNavigator, toggleFavorite } from "./tracks.js";
import { $, $$, artistNames, ask, confirmBox, cover, esc, fmtCount, fmtTime, ICON, plural, PROVIDERS, toast } from "./ui.js";

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
  view.scrollTop = 0;
  view.classList.remove("in"); void view.offsetWidth; view.classList.add("in");
  if (name !== "search") $("#searchInput").value = "";
  const page = PAGES[name] || PAGES.home;
  page(params);
}
setNavigator(navigate);

export function goBack() {
  const previous = stack.pop();
  if (previous) navigate(previous.name, previous.params, { back: true });
}

export const currentView = () => current;

const heroPlay = (label = "Слушать") => `<button class="btn primary big" data-act="play">${ICON.play}<span>${label}</span></button>`;

function section(title, body, extra = "") {
  return `<section class="sec"><div class="sec-head"><h2>${title}</h2>${extra}</div>${body}</section>`;
}

/* ───── home ───── */

async function home() {
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Доброй ночи" : hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер";
  const suggested = hour < 5 || hour >= 22 ? ["night", "sad", "chill"] : hour < 11 ? ["energy", "focus", "drive"] : hour < 18 ? ["focus", "drive", "party"] : ["chill", "love", "party"];
  view.innerHTML = `
    <div class="page">
      <h1 class="greet">${greeting}</h1>
      <p class="lead">Включи настроение — подберу треки и звук. Всё, что в избранном, само скачивается и готовится в 3D, пока ты не слушаешь.</p>
      <div class="mood-strip">${suggested.map((id) => moodCard(MOODS.find((m) => m.id === id), "wide")).join("")}</div>
      <div id="homeRecent"></div>
      <div id="homeFav"></div>
      <div id="homeLists"></div>
    </div>`;
  wireMoodCards(view);
  const [history, favorites] = await Promise.all([api.history().catch(() => []), api.favorites().catch(() => [])]);
  if (current?.name !== "home") return;
  history.concat(favorites).forEach((t) => library.set(t.id, t));
  if (history.length) {
    $("#homeRecent").innerHTML = section("Недавно слушал", `<div class="tiles">${history.slice(0, 12).map((t, i) => tile(t, i)).join("")}</div>`);
    wireTiles($("#homeRecent"), history.slice(0, 12), { type: "history", label: "Недавнее" });
  }
  if (favorites.length) {
    $("#homeFav").innerHTML = section("Из избранного", `<div id="homeFavList"></div>`, `<button class="link" data-goto="favorites">Все ${favorites.length}</button>`);
    renderTracks($("#homeFavList"), favorites.slice(0, 6), { context: { type: "favorites", label: "Избранное" } });
  }
  if (!history.length && !favorites.length) {
    $("#homeRecent").innerHTML = `<div class="onboard">
      <div><b>1. Найди музыку</b><span>Поиск идёт сразу по Яндекс Музыке, SoundCloud и Spotify. Один трек с разных площадок показывается один раз.</span></div>
      <div><b>2. Жми ♥</b><span>Избранное скачивается и разбирается на вокал, бас, ударные и музыку — это и есть настоящий 3D.</span></div>
      <div><b>3. Слушай в наушниках</b><span>Стиль трека определится сам, сцена подстроится. Или выбери настроение.</span></div>
    </div>`;
  }
  const lists = playlistsCache.list;
  if (lists.length) {
    $("#homeLists").innerHTML = section("Плейлисты", `<div class="tiles">${lists.map(playlistTile).join("")}</div>`);
    $$("[data-playlist]", $("#homeLists")).forEach((el) => el.addEventListener("click", () => navigate("playlist", { id: Number(el.dataset.playlist) })));
  }
  $$("[data-goto]", view).forEach((el) => el.addEventListener("click", () => navigate(el.dataset.goto)));
}

function tile(track, index) {
  return `<button class="tile" data-index="${index}">${cover(track.cover, "lg")}<span class="tile-play">${ICON.play}</span><b>${esc(track.title)}</b><small>${esc(artistNames(track))}</small></button>`;
}

function wireTiles(root, tracks, context) {
  $$(".tile", root).forEach((el) => el.addEventListener("click", () => player.playList(tracks, Number(el.dataset.index), context)));
}

function playlistTile(p) {
  return `<button class="tile" data-playlist="${p.id}">${collage(p.covers)}<b>${esc(p.name)}</b><small>${p.count} ${plural(p.count, "трек", "трека", "треков")}${p.count ? ` · ${p.ready} в 3D` : ""}</small></button>`;
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
    view.innerHTML = `<div class="page"><h1>Поиск</h1><p class="lead">Ищу сразу в Яндекс Музыке, SoundCloud и Spotify. Дубликаты одного трека с разных площадок склеиваются в одну строку — значки справа показывают, где он есть.</p>
      ${section("Или просто настроение", `<div class="mood-grid">${MOODS.map((m) => moodCard(m)).join("")}</div>`)}</div>`;
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
    view.innerHTML = `<div class="page">${errors}<div class="empty-big"><b>Ничего не нашлось</b><span>Попробуй иначе написать название или имя артиста.</span></div></div>`;
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
            <div><b>${esc(top.title)}</b><span>${esc(artistNames(top))}</span>
              <div class="chips">${top.album ? `<span class="chip">${esc(top.album)}</span>` : ""}${top.year ? `<span class="chip">${top.year}</span>` : ""}${top.genre ? `<span class="chip">${esc(top.genre)}</span>` : ""}<span class="chip">${fmtTime(top.duration)}</span></div>
            </div>
            <button class="play-fab" data-act="play">${ICON.play}</button>
          </div>
        </div>
        <div class="best-list"><h2>Треки</h2><div id="topTracks"></div></div>
      </div>
      ${result.artists.length ? section("Артисты", `<div class="artist-row">${result.artists.slice(0, 8).map(artistBubble).join("")}</div>`) : ""}
      ${rest.length > 4 ? section("Все треки", `<div id="moreTracks"></div>`) : ""}
    </div>`;
  const context = { type: "search", label: `Поиск: ${query}` };
  $("#bestCard").addEventListener("click", () => player.playList(result.tracks, 0, context));
  renderTracks($("#topTracks"), result.tracks.slice(0, 5), { context, album: false });
  if (rest.length > 4) renderTracks($("#moreTracks"), result.tracks.slice(5), { context });
  wireArtists(view);
}

function artistBubble(a) {
  const providers = [...new Set(a.sources.map((s) => s.provider))].map((p) => PROVIDERS[p]?.short).join(" · ");
  return `<button class="artist-bubble" data-artist="${esc(a.id)}">${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" />` : `<span class="ph">${esc(a.name[0] || "?")}</span>`}<b>${esc(a.name)}</b><small>${a.followers ? `${fmtCount(a.followers)} · ` : ""}${providers}</small></button>`;
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
    view.innerHTML = `<div class="page"><div class="empty-big"><b>Не удалось открыть артиста</b><span>${esc(error)}</span></div></div>`;
    return;
  }
  if (current?.params?.id !== id) return;
  const a = page.artist;
  const hero = page.images[0] || a.image;
  const stats = [
    page.listeners ? `${fmtCount(page.listeners)} слушателей в месяц` : null,
    page.likes ? `${fmtCount(page.likes)} ${a.sources.some((s) => s.provider === "yandex") ? "лайков" : "подписчиков"}` : null,
  ].filter(Boolean).join(" · ");
  const providers = [...new Set(page.providers)].map((p) => `<span class="src src-${p}" style="--c:${PROVIDERS[p]?.color}">${PROVIDERS[p]?.short}</span>`).join("");
  const context = { type: "artist", label: a.name, id };
  view.innerHTML = `
    <div class="artist-hero" style="--hero:url('${esc(hero || "")}')">
      <div class="hero-shade"></div>
      <div class="hero-content">
        ${a.image ? `<img class="hero-avatar" src="${esc(a.image)}" alt="" />` : ""}
        <div>
          <span class="eyebrow">Артист ${providers}</span>
          <h1>${esc(a.name)}</h1>
          <p>${stats}${a.genres.length ? ` · ${a.genres.slice(0, 3).map(esc).join(", ")}` : ""}</p>
          <div class="hero-actions">${heroPlay()}<button class="btn ghost" data-act="shuffle">${ICON.shuffle}<span>Перемешать</span></button><button class="btn ghost" data-act="favall">${ICON.heart}<span>Всё популярное в избранное</span></button></div>
        </div>
      </div>
    </div>
    <div class="page">
      ${section("Популярное", `<div id="artistTracks"></div>`)}
      ${page.albums.length ? section("Альбомы и синглы", `<div class="tiles">${page.albums.map((al) => `<button class="tile" data-album="${esc(al.id)}" data-title="${esc(al.title)}" data-cover="${esc(al.cover || "")}">${cover(al.cover, "lg")}<b>${esc(al.title)}</b><small>${al.year || ""}${al.kind === "single" ? " · сингл" : ""}</small></button>`).join("")}</div>`) : ""}
      ${page.description ? section("Об артисте", `<div class="about"><p>${esc(page.description)}</p></div>`) : ""}
      ${page.images.length > 1 ? section("Фото", `<div class="photos">${page.images.slice(0, 6).map((src) => `<img src="${esc(src)}" alt="" loading="lazy" />`).join("")}</div>`) : ""}
      ${page.similar.length ? section("Похожие", `<div class="artist-row">${page.similar.slice(0, 10).map(artistBubble).join("")}</div>`) : ""}
      ${page.links.length ? section("Ссылки", `<div class="links">${dedupeLinks(page.links).map((l) => `<a href="${esc(l.url)}" target="_blank" class="chip link-chip">${ICON.ext}${esc(l.title)}</a>`).join("")}</div>`) : ""}
    </div>`;
  renderTracks($("#artistTracks"), page.tracks, { context });
  $('[data-act="play"]', view).addEventListener("click", () => player.playList(page.tracks, 0, context));
  $('[data-act="shuffle"]', view).addEventListener("click", () => { player.setShuffle(true); player.playList(page.tracks, Math.floor(Math.random() * page.tracks.length), context); });
  $('[data-act="favall"]', view).addEventListener("click", async () => {
    for (const t of page.tracks) if (!library.get(t.id)?.favorite) await toggleFavorite(t);
  });
  $$("[data-album]", view).forEach((el) => el.addEventListener("click", () => navigate("album", { id: el.dataset.album, title: el.dataset.title, cover: el.dataset.cover, artist: a.name })));
  wireArtists(view);
}

function dedupeLinks(links) {
  const seen = new Set();
  return links.filter((l) => !seen.has(l.url) && seen.add(l.url));
}

/* ───── album ───── */

async function album({ id, title, cover: art, artist: artistName }) {
  view.innerHTML = `<div class="page">${listHeader({ kind: "Альбом", title, sub: artistName, art: cover(art, "hero") })}<div id="albumTracks"><div class="skeleton-list">${"<div></div>".repeat(8)}</div></div></div>`;
  let tracks;
  try { tracks = await api.album(id); } catch (error) { $("#albumTracks").innerHTML = `<div class="empty-note">${esc(error)}</div>`; return; }
  const context = { type: "album", label: title, id };
  const total = tracks.reduce((s, t) => s + t.duration, 0);
  $(".list-sub", view).textContent = `${artistName} · ${tracks.length} ${plural(tracks.length, "трек", "трека", "треков")} · ${fmtTime(total)}`;
  renderTracks($("#albumTracks"), tracks, { context, album: false });
  wireListActions(tracks, context, { title });
}

function listHeader({ kind, title, sub, art, extra = "" }) {
  return `<header class="list-head">${art}<div><span class="eyebrow">${kind}</span><h1>${esc(title)}</h1><p class="list-sub">${esc(sub || "")}</p>
    <div class="hero-actions">${heroPlay()}<button class="btn ghost" data-act="shuffle">${ICON.shuffle}<span>Перемешать</span></button><button class="btn ghost" data-act="saveas">${ICON.plus}<span>Сохранить как плейлист</span></button>${extra}</div></div></header>`;
}

function wireListActions(tracks, context, { title }) {
  $('[data-act="play"]', view)?.addEventListener("click", () => tracks.length && player.playList(tracks, 0, context));
  $('[data-act="shuffle"]', view)?.addEventListener("click", () => { if (!tracks.length) return; player.setShuffle(true); player.playList(tracks, Math.floor(Math.random() * tracks.length), context); });
  $('[data-act="saveas"]', view)?.addEventListener("click", async () => {
    const id = await api.playlistCreate(title, tracks);
    await refreshPlaylists();
    toast(`Плейлист «${title}» сохранён — треки скачаются и подготовятся в 3D`);
    navigate("playlist", { id });
  });
}

/* ───── favourites ───── */

async function favorites() {
  const tracks = await api.favorites().catch(() => []);
  tracks.forEach((t) => library.set(t.id, t));
  const ready = tracks.filter((t) => t.state === "ready").length;
  const total = tracks.reduce((s, t) => s + t.duration, 0);
  view.innerHTML = `<div class="page">
    ${listHeader({ kind: "Коллекция", title: "Избранное", sub: `${tracks.length} ${plural(tracks.length, "трек", "трека", "треков")} · ${fmtTime(total)} · ${ready} готово в 3D`, art: `<div class="cover hero fav-art">${ICON.heart}</div>` })}
    <div id="favTracks"></div></div>`;
  $('[data-act="saveas"]', view)?.remove();
  renderTracks($("#favTracks"), tracks, { context: { type: "favorites", label: "Избранное" }, empty: "Жми ♥ у любого трека — он появится здесь, скачается и подготовится в 3D." });
  wireListActions(tracks, { type: "favorites", label: "Избранное" }, { title: "Избранное" });
}

/* ───── playlist ───── */

async function playlist({ id }) {
  await refreshPlaylists();
  const meta = playlistsCache.list.find((p) => p.id === id);
  if (!meta) { navigate("home", {}, { replace: true }); return; }
  const tracks = await api.playlistTracks(id).catch(() => []);
  tracks.forEach((t) => library.set(t.id, t));
  const total = tracks.reduce((s, t) => s + t.duration, 0);
  const context = { type: "playlist", label: meta.name, id };
  view.innerHTML = `<div class="page">
    ${listHeader({
      kind: "Плейлист", title: meta.name,
      sub: `${tracks.length} ${plural(tracks.length, "трек", "трека", "треков")} · ${fmtTime(total)} · ${meta.ready} готово в 3D`,
      art: collage(meta.covers, "hero"),
      extra: `<button class="icon-btn" data-act="rename" title="Переименовать">${ICON.edit}</button><button class="icon-btn" data-act="delete" title="Удалить плейлист">${ICON.trash}</button>`,
    })}
    <div id="plTracks"></div></div>`;
  $('[data-act="saveas"]', view)?.remove();
  const redraw = renderTracks($("#plTracks"), tracks, {
    context, reorder: true, playlistId: id,
    empty: "Плейлист пуст. Найди трек и добавь через «⋯» → «Добавить в плейлист».",
    onReorder: (list) => api.playlistReorder(id, list.map((t) => t.id)),
    onRemove: async (track) => {
      await api.playlistRemove(id, track.id);
      tracks.splice(tracks.findIndex((t) => t.id === track.id), 1);
      redraw(); refreshPlaylists();
    },
  });
  wireListActions(tracks, context, { title: meta.name });
  $('[data-act="rename"]', view).addEventListener("click", async () => {
    const name = await ask("Название плейлиста", { value: meta.name });
    if (name) { await api.playlistRename(id, name); await refreshPlaylists(); navigate("playlist", { id }, { replace: true }); }
  });
  $('[data-act="delete"]', view).addEventListener("click", async () => {
    if (await confirmBox("Удалить плейлист?", `«${meta.name}» исчезнет. Сами треки останутся в избранном и истории.`)) {
      await api.playlistDelete(id); await refreshPlaylists(); navigate("home", {}, { replace: true });
    }
  });
}

/* ───── mood ───── */

function moodCard(mood, size = "") {
  return `<button class="mood-card ${size}" data-mood="${mood.id}" style="--a:${mood.colors[0]};--b:${mood.colors[1]}"><span class="mood-glow"></span><b>${mood.label}</b><small>${mood.sub}</small><span class="mood-play">${ICON.play}</span></button>`;
}

function wireMoodCards(root) {
  $$("[data-mood]", root).forEach((el) => el.addEventListener("click", () => startMood(el.dataset.mood, el)));
}

export async function startMood(id, el) {
  const mood = MOODS.find((m) => m.id === id);
  el?.classList.add("loading");
  try {
    const { queue, fromLibrary, discovered } = await buildMoodQueue(mood);
    if (!queue.length) { toast("Не нашёл подходящих треков — добавь музыку в избранное", { error: true }); return; }
    await player.playList(queue, 0, { type: "mood", id, label: `Настроение · ${mood.label}` });
    toast(`${mood.label}: ${fromLibrary} из твоей музыки${discovered ? `, ${discovered} новых` : ""}. Звук настроен под настроение.`);
    api.prefSet("lastMood", id);
  } finally {
    el?.classList.remove("loading");
  }
}

async function mood() {
  const last = await api.prefGet("lastMood", null);
  view.innerHTML = `<div class="page">
    <h1>Какое настроение?</h1>
    <p class="lead">Выбери — подберу треки из твоей музыки (и найду новые, если своих мало) и настрою 3D-сцену: комнату, движение, Slowed и Reverb.</p>
    <div class="mood-grid">${MOODS.map((m) => moodCard(m, m.id === last ? "last" : "")).join("")}</div>
  </div>`;
  wireMoodCards(view);
}

/* ───── settings ───── */

async function settings() {
  view.innerHTML = `<div class="page narrow"><h1>Настройки</h1><div id="settingsBody"><div class="skeleton-list">${"<div></div>".repeat(4)}</div></div></div>`;
  const [accounts, prep] = await Promise.all([api.accounts().catch(() => ({})), api.prepStatus().catch(() => null)]);
  const ya = accounts.yandex || {};
  const s = player.settings;
  $("#settingsBody").innerHTML = `
    <section class="card">
      <div class="card-head"><span class="src src-yandex big" style="--c:${PROVIDERS.yandex.color}">Я</span><div><b>Яндекс Музыка</b><small>${ya.connected ? `Вход выполнен: ${esc(ya.login)}${ya.plus ? " · Плюс" : " · без Плюса — полные треки недоступны"}` : "Поиск работает и так. Войди, чтобы слушать полные треки и получать тексты."}</small></div>
      ${ya.connected ? `<button class="btn ghost" id="yaOut">Выйти</button>` : `<button class="btn primary" id="yaIn">Войти</button>`}</div>
      ${ya.error ? `<div class="note warn">${esc(ya.error)} — войди заново.</div>` : ""}
      <p class="hint">Откроется официальная страница входа Яндекса. Пароль вводится только там — приложение получает лишь токен доступа и хранит его у тебя на компьютере.</p>
    </section>
    <section class="card">
      <div class="card-head"><span class="src src-soundcloud big" style="--c:${PROVIDERS.soundcloud.color}">SC</span><div><b>SoundCloud</b><small>Подключён автоматически. Треки, которые авторы выложили целиком, слушаются полностью.</small></div><span class="badge ok">✓</span></div>
    </section>
    <section class="card">
      <div class="card-head"><span class="src src-spotify big" style="--c:${PROVIDERS.spotify.color}">S</span><div><b>Spotify</b><small>${accounts.spotify?.configured ? "Подключён: поиск, обложки, информация об артистах." : "Необязательно. Даёт поиск по каталогу Spotify и данные об артистах. Само аудио Spotify защищено — трек будет взят с другой площадки."}</small></div></div>
      <details ${accounts.spotify?.configured ? "" : "open"}><summary>Ключи разработчика</summary>
        <p class="hint">Создай приложение на developer.spotify.com/dashboard (бесплатно, 1 минута) и вставь Client ID и Client Secret.</p>
        <div class="form-row"><input id="spId" placeholder="Client ID" autocomplete="off" spellcheck="false" /><input id="spSecret" placeholder="Client Secret" type="password" autocomplete="off" /><button class="btn" id="spSave">Сохранить</button></div>
      </details>
    </section>
    <section class="card">
      <div class="card-head"><span class="ai-dot ${prep?.ai ? "on" : ""}"></span><div><b>3D-подготовка</b><small>${prep ? `${prep.ready} из ${prep.total} треков готовы в 3D${prep.pending ? `, ещё ${prep.pending} в работе` : ""}.` : ""} ${prep?.ai ? "Разделение на стемы идёт, когда музыка на паузе." : "AI-разделение не найдено — треки играют в 3D без разделения на стемы."}</small></div><button class="btn ghost" id="retry">Повторить ошибки</button></div>
    </section>
    <section class="card">
      <div class="card-head"><div><b>Звук</b><small>Для настоящего 3D нужны наушники.</small></div></div>
      <label class="switch-row"><span>3D-звук<small>Бинауральная сцена HRTF</small></span><input type="checkbox" id="setSpatial" ${s.spatial ? "checked" : ""} /></label>
      <label class="switch-row"><span>Режим наушников<small>Выключи, если слушаешь через колонки</small></span><input type="checkbox" id="setHeadphone" ${s.headphone ? "checked" : ""} /></label>
      <label class="switch-row"><span>Автостиль<small>Определять жанр и подбирать сцену для каждого трека</small></span><input type="checkbox" id="setAuto" ${s.autoStyle ? "checked" : ""} /></label>
    </section>`;
  $("#yaIn")?.addEventListener("click", () => api.yandexLogin());
  $("#yaOut")?.addEventListener("click", async () => { await api.yandexLogout(); settings(); });
  $("#spSave").addEventListener("click", async () => { await api.spotifyKeys($("#spId").value, $("#spSecret").value); toast("Spotify сохранён"); settings(); });
  $("#retry").addEventListener("click", async () => { await api.retryFailed(); toast("Повторю загрузку и разбор"); });
  $("#setSpatial").addEventListener("change", (e) => player.apply({ spatial: e.target.checked }, { manual: false }));
  $("#setHeadphone").addEventListener("change", (e) => player.apply({ headphone: e.target.checked }, { manual: false }));
  $("#setAuto").addEventListener("change", (e) => player.chooseStyle(e.target.checked ? "auto" : player.settings.style || "pop"));
}

const PAGES = { home, search, artist, album, favorites, playlist, mood, settings };

/* ───── sidebar playlists ───── */

export function renderSidePlaylists() {
  const root = $("#sidePlaylists");
  const lists = playlistsCache.list;
  root.innerHTML = lists.length
    ? lists.map((p) => `<button class="side-playlist ${current?.name === "playlist" && current.params.id === p.id ? "active" : ""}" data-id="${p.id}">${collage(p.covers, "xs")}<span><b>${esc(p.name)}</b><small>${p.count} ${plural(p.count, "трек", "трека", "треков")}</small></span></button>`).join("")
    : `<p class="side-empty">Создай первый плейлист кнопкой +</p>`;
  $$(".side-playlist", root).forEach((el) => el.addEventListener("click", () => navigate("playlist", { id: Number(el.dataset.id) })));
}

document.addEventListener("playlists-changed", renderSidePlaylists);
$("#newPlaylist").addEventListener("click", async () => {
  const id = await newPlaylist();
  if (id) navigate("playlist", { id });
});

