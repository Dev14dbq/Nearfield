/* Small UI helpers shared by all views. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export function fmtCount(n) {
  if (n == null) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".0", "")} млн`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(".0", "")} тыс.`;
  return String(n);
}

export function plural(n, one, few, many) {
  const m10 = n % 10; const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const PROVIDERS = {
  yandex: { short: "Я", label: "Яндекс Музыка", color: "#ffcc00" },
  soundcloud: { short: "SC", label: "SoundCloud", color: "#ff5500" },
  spotify: { short: "S", label: "Spotify", color: "#1ed760" },
};

export function sourceBadges(track) {
  const seen = new Set();
  return (track.sources || [])
    .filter((s) => !seen.has(s.provider) && seen.add(s.provider))
    .map((s) => {
      const p = PROVIDERS[s.provider] || { short: "?", label: s.provider, color: "#888" };
      const audio = s.audio === "full" ? "полный трек" : s.audio === "preview" ? "только превью" : "только информация";
      return `<span class="src src-${s.provider}" style="--c:${p.color}" title="${p.label}: ${audio}">${p.short}</span>`;
    })
    .join("");
}

export function artistLinks(track) {
  return (track.artists || [])
    .map((a) => (a.id ? `<button class="link" data-artist="${esc(a.id)}">${esc(a.name)}</button>` : `<span>${esc(a.name)}</span>`))
    .join(", ");
}

export const artistNames = (track) => (track.artists || []).map((a) => a.name).join(", ");

// Only what matters to a listener: the track is ready in full 3D, it is a short preview, or it failed.
export function stateBadge(item) {
  if (!item) return "";
  if (item.preview) return `<span class="badge warn" title="Доступно только 30 секунд">30 с</span>`;
  if (item.state === "ready") return `<span class="badge ok" title="Полное 3D-звучание">3D</span>`;
  if (item.state === "error") return `<span class="badge err" title="Не удалось скачать">!</span>`;
  return "";
}

export function cover(url, size = "") {
  return url ? `<img class="cover ${size}" src="${esc(url)}" alt="" loading="lazy" />` : `<div class="cover ${size} empty"><svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg></div>`;
}

const HEART = `<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/></svg>`;
export const ICON = {
  heart: HEART,
  more: `<svg viewBox="0 0 24 24" class="fill"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`,
  play: `<svg viewBox="0 0 24 24" class="fill"><path d="M8 5.5v13l11-6.5z"/></svg>`,
  shuffle: `<svg viewBox="0 0 24 24"><path d="M16 4h4v4M4 20 20 4M20 16v4h-4M15 15l5 5M4 4l5 5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`,
  trash: `<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>`,
  edit: `<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`,
  grip: `<svg viewBox="0 0 24 24" class="fill"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`,
  sliders: `<svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>`,
  queue: `<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>`,
  expand: `<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
  user: `<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>`,
  sync: `<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/></svg>`,
  ext: `<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
};

let toastTimer = 0;
export function toast(text, { error = false, action = null } = {}) {
  const zone = $("#toasts");
  const node = document.createElement("div");
  node.className = `toast ${error ? "error" : ""}`;
  node.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action.label)}</button>` : ""}`;
  if (action) node.querySelector("button").addEventListener("click", () => { action.run(); node.remove(); });
  zone.append(node);
  requestAnimationFrame(() => node.classList.add("in"));
  clearTimeout(toastTimer);
  setTimeout(() => { node.classList.remove("in"); setTimeout(() => node.remove(), 300); }, error ? 6000 : 3200);
}

/** Context menu at the pointer. items: [{ label, icon?, run, danger?, sub? }] or "-" */
export function openMenu(event, items) {
  const menu = $("#menu");
  const render = (list) => {
    menu.innerHTML = list.map((item, i) => (item === "-" ? `<hr />` : `<button data-i="${i}" class="${item.danger ? "danger" : ""}">${item.icon || ""}<span>${esc(item.label)}</span>${item.sub ? "<em>›</em>" : ""}</button>`)).join("");
    menu.querySelectorAll("button").forEach((button) => button.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = list[Number(button.dataset.i)];
      if (item.sub) { render(item.sub()); return; }
      closeMenu(); item.run?.();
    }));
  };
  render(items);
  menu.hidden = false;
  const { innerWidth: w, innerHeight: h } = window;
  const rect = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, w - rect.width - 8); const y = Math.min(event.clientY, h - rect.height - 8);
  menu.style.left = `${Math.max(8, x)}px`; menu.style.top = `${Math.max(8, y)}px`;
  event.preventDefault(); event.stopPropagation();
}

export function closeMenu() { $("#menu").hidden = true; }
document.addEventListener("click", closeMenu);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

/** Simple prompt in a styled dialog. Resolves with the text or null. */
export function ask(title, { value = "", placeholder = "", confirm = "Сохранить" } = {}) {
  const modal = $("#modal");
  modal.innerHTML = `<form method="dialog" class="ask"><h3>${esc(title)}</h3><input name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="80" autocomplete="off" /><div class="row"><button value="cancel" class="btn ghost">Отмена</button><button value="ok" class="btn primary">${esc(confirm)}</button></div></form>`;
  const input = modal.querySelector("input");
  modal.showModal();
  input.focus(); input.select();
  return new Promise((resolve) => {
    modal.addEventListener("close", () => resolve(modal.returnValue === "ok" && input.value.trim() ? input.value.trim() : null), { once: true });
  });
}

export function confirmBox(title, text, confirm = "Удалить") {
  const modal = $("#modal");
  modal.innerHTML = `<form method="dialog" class="ask"><h3>${esc(title)}</h3><p>${esc(text)}</p><div class="row"><button value="cancel" class="btn ghost">Отмена</button><button value="ok" class="btn danger">${esc(confirm)}</button></div></form>`;
  modal.showModal();
  return new Promise((resolve) => modal.addEventListener("close", () => resolve(modal.returnValue === "ok"), { once: true }));
}
