"use strict";

const els = {
  filters: document.getElementById("filters"),
  title: document.getElementById("niche-title"),
  count: document.getElementById("count"),
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  toast: document.getElementById("toast"),
};

// Textos de tela: nada de nome de arquivo ou de termo técnico.
const ERROR_COPY = {
  unknown_niche: "Este filtro não está mais no Lookbook.",
  rate_limited: "O Pinterest pediu uma pausa. Tente de novo em alguns minutos.",
  empty: "Nenhuma foto para este filtro agora. Costuma ser temporário.",
  config_invalid_json: "Não foi possível ler a lista de filtros. Reinstale o Lookbook.",
  config_missing: "Não foi possível ler a lista de filtros. Reinstale o Lookbook.",
  index_unreadable: "A pasta de favoritos tem um problema. Abra a pasta para conferir.",
  network_error: "Sem conexão. Verifique a internet e tente de novo.",
  timeout: "O Pinterest demorou demais para responder. Tente de novo.",
  image_http_error: "Não foi possível baixar esta imagem. Tente outra foto.",
  image_not_an_image: "Essa imagem veio corrompida. Tente outra foto.",
  no_image: "Essa foto não tem imagem para salvar.",
  invalid_photo: "Não foi possível identificar essa foto.",
};

// Só oferece "tentar de novo" quando repetir pode resolver.
const RETRYABLE = new Set(["empty", "rate_limited", "network_error", "timeout"]);

const HEART =
  "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 " +
  "3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 " +
  "3.78-3.4 6.86-8.55 11.54L12 21.35z";

const state = {
  niches: [],
  currentId: null,
  mode: "niche",
  favorites: [],
  favoriteIds: new Set(),
  favoriteDir: "",
  pending: new Set(),
  requestId: 0,
};

let toastTimer = null;
let prefetched = false;

/* ---------- utilidades ---------- */

function errorText(code) {
  return ERROR_COPY[code] || "Algo deu errado. Tente de novo.";
}

function heartSvg(className) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", HEART);
  svg.append(path);
  return svg;
}

function hideToast() {
  els.toast.classList.remove("is-on", "is-actionable");
  window.clearTimeout(toastTimer);
}

function toast(message, action = null) {
  els.toast.replaceChildren(document.createTextNode(message));
  els.toast.classList.toggle("is-actionable", Boolean(action));

  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      hideToast();
      action.onClick();
    });
    els.toast.append(button);
  }

  els.toast.classList.add("is-on");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, action ? 8000 : 2200);
}

function setStatus(text, { actions = [], error = false } = {}) {
  els.status.replaceChildren();
  els.status.classList.toggle("is-error", error);

  if (!text) return;

  els.status.append(document.createTextNode(text));

  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "action";
    button.textContent = action.label;
    if (action.title) button.title = action.title;
    button.addEventListener("click", action.onClick);
    els.status.append(button);
  }
}

function setTitle(text) {
  els.title.classList.add("is-fading");
  window.setTimeout(() => {
    els.title.textContent = text;
    els.title.classList.remove("is-fading");
  }, 120);
}

/* ---------- filtros ---------- */

function renderFilters() {
  els.filters.replaceChildren();

  for (const niche of state.niches) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = niche.label;
    chip.setAttribute("aria-pressed", String(state.mode === "niche" && niche.id === state.currentId));
    chip.addEventListener("click", () => selectNiche(niche.id));
    els.filters.append(chip);
  }

  const saved = document.createElement("button");
  saved.type = "button";
  saved.className = "chip";
  saved.setAttribute("aria-pressed", String(state.mode === "favorites"));
  saved.append(heartSvg(), document.createTextNode("Favoritos"));

  if (state.favoriteIds.size > 0) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = String(state.favoriteIds.size);
    saved.append(badge);
  }

  saved.addEventListener("click", selectFavorites);
  els.filters.append(saved);
}

/* ---------- favoritos ---------- */

function paintSaveButton(button, isSaved, photo) {
  const suffix = photo?.title ? `: ${photo.title}` : "";
  button.setAttribute("aria-pressed", String(isSaved));
  button.setAttribute("aria-label", (isSaved ? "Remover dos favoritos" : "Salvar nos favoritos") + suffix);
  button.title = isSaved ? "Remover dos favoritos" : "Salvar nos favoritos";
}

function createSaveButton(photo) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "save";
  paintSaveButton(button, state.favoriteIds.has(photo.id), photo);
  button.append(heartSvg());

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleFavorite(photo, button);
  });

  return button;
}

function paintHeartById(photo) {
  const item = els.grid.querySelector(`li[data-id="${CSS.escape(photo.id)}"]`);
  const button = item?.querySelector(".save");
  if (button) paintSaveButton(button, state.favoriteIds.has(photo.id), photo);
}

async function toggleFavorite(photo, button) {
  if (state.pending.has(photo.id)) return;

  const wasSaved = state.favoriteIds.has(photo.id);
  state.pending.add(photo.id);
  button.setAttribute("aria-busy", "true");

  // Otimista: a interface responde antes do disco.
  setFavorite(photo.id, !wasSaved);
  paintSaveButton(button, !wasSaved, photo);
  button.classList.remove("is-pop");
  void button.offsetWidth; // reinicia a animação
  button.classList.add("is-pop");
  renderFilters();

  let result;
  try {
    result = wasSaved
      ? await window.lookbook.favorites.remove(photo.id)
      : await window.lookbook.favorites.add(photo, state.currentId);
  } catch {
    result = { ok: false, error: "unknown" };
  } finally {
    state.pending.delete(photo.id);
    button.removeAttribute("aria-busy");
  }

  if (!result?.ok) {
    // Reverte e deixa o erro na tela, com opção de repetir.
    setFavorite(photo.id, wasSaved);
    paintSaveButton(button, wasSaved, photo);
    renderFilters();
    setStatus(errorText(result?.error), {
      error: true,
      actions: [
        {
          label: "Tentar de novo",
          onClick: () => (wasSaved ? toggleFavorite(photo, button) : retrySave(photo)),
        },
      ],
    });
    return;
  }

  if (wasSaved) {
    state.favorites = state.favorites.filter((entry) => entry.id !== photo.id);
    setStatus("");
    toast("Removido. O arquivo foi para a lixeira.", {
      label: "Desfazer",
      onClick: () => undoRemove(result.removed),
    });
    if (state.mode === "favorites") renderFavorites();
    return;
  }

  state.favorites.push(result.item);
  setStatus("");
  toast("Salvo em Favoritos");
  if (state.mode === "favorites") renderFavorites();
}

function setFavorite(id, on) {
  if (on) state.favoriteIds.add(id);
  else state.favoriteIds.delete(id);
}

async function retrySave(photo) {
  setStatus("Salvando…");

  let result;
  try {
    result = await window.lookbook.favorites.add(photo, state.currentId);
  } catch {
    result = { ok: false, error: "unknown" };
  }

  if (!result?.ok) {
    setStatus(errorText(result?.error), {
      error: true,
      actions: [{ label: "Tentar de novo", onClick: () => retrySave(photo) }],
    });
    return;
  }

  setFavorite(photo.id, true);
  state.favorites.push(result.item);
  renderFilters();
  paintHeartById(photo);
  setStatus("");
  toast("Salvo em Favoritos");
  if (state.mode === "favorites") renderFavorites();
}

async function undoRemove(entry) {
  if (!entry) return;

  let result;
  try {
    result = await window.lookbook.favorites.restore(entry);
  } catch {
    result = { ok: false, error: "unknown" };
  }

  if (!result?.ok) {
    setStatus("Não foi possível restaurar esse look.", { error: true });
    return;
  }

  setFavorite(entry.id, true);
  if (!state.favorites.some((item) => item.id === entry.id)) state.favorites.push(entry);
  renderFilters();
  paintHeartById(entry);
  if (state.mode === "favorites") renderFavorites();
  toast("Look restaurado");
}

function favoriteToPhoto(entry) {
  const url = `lookbook://fav/${encodeURIComponent(entry.file)}`;
  return {
    id: entry.id,
    image: url,
    thumb: url,
    width: entry.width,
    height: entry.height,
    title: entry.title,
    link: entry.link,
    author: entry.author,
  };
}

async function openFolder() {
  const result = await window.lookbook.favorites.openFolder();
  if (!result?.ok) toast("Não foi possível abrir a pasta");
}

async function removeEntry(entry) {
  let result;
  try {
    result = await window.lookbook.favorites.remove(entry.id);
  } catch {
    result = { ok: false, error: "unknown" };
  }

  if (!result?.ok) {
    setStatus(errorText(result?.error), { error: true });
    return;
  }

  setFavorite(entry.id, false);
  state.favorites = state.favorites.filter((item) => item.id !== entry.id);
  renderFilters();
  renderFavorites();
}

function createMissingItem(entry) {
  const item = document.createElement("li");

  const box = document.createElement("div");
  box.className = "missing-box";

  const title = document.createElement("p");
  title.textContent = "Arquivo não encontrado";

  const detail = document.createElement("p");
  detail.className = "muted";
  detail.textContent = entry.title || entry.file;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "action";
  button.textContent = "Tirar da lista";
  button.addEventListener("click", () => removeEntry(entry));

  box.append(title, detail, button);
  item.append(box);
  return item;
}

function renderEmptyFavorites() {
  els.grid.replaceChildren();
  els.grid.removeAttribute("aria-busy");
  els.count.textContent = "";
  setStatus("");

  const item = document.createElement("li");
  item.className = "empty";

  const wrap = document.createElement("div");
  wrap.className = "empty";

  const heading = document.createElement("h2");
  heading.textContent = "Nenhum look salvo";

  const text = document.createElement("p");
  text.textContent = "Toque no coração de uma foto para guardar o look neste computador.";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.textContent = "Ver looks";
  button.addEventListener("click", () => selectNiche(state.niches[0]?.id));

  wrap.append(heartSvg(), heading, text, button);
  item.append(wrap);
  els.grid.append(item);
}

function renderFavorites() {
  const items = state.favorites.filter((entry) => state.favoriteIds.has(entry.id));
  if (!items.length) {
    renderEmptyFavorites();
    return;
  }

  const found = items.filter((entry) => !entry.missing);
  const missing = items.filter((entry) => entry.missing);

  const fragment = document.createDocumentFragment();
  for (const entry of found) fragment.append(createPhotoItem(favoriteToPhoto(entry)));
  for (const entry of missing) fragment.append(createMissingItem(entry));
  els.grid.replaceChildren(fragment);
  els.grid.removeAttribute("aria-busy");

  els.count.textContent = items.length === 1 ? "1 look" : `${items.length} looks`;

  const actions = [{ label: "Abrir pasta", onClick: openFolder, title: state.favoriteDir }];

  if (missing.length) {
    const plural = missing.length > 1 ? "arquivos" : "arquivo";
    setStatus(
      `${found.length} de ${items.length} looks. ${missing.length} ${plural} não está na pasta.`,
      { actions }
    );
    return;
  }

  setStatus("Guardados neste computador.", { actions });
}

async function selectFavorites() {
  const mine = ++state.requestId;
  state.mode = "favorites";
  state.currentId = null;
  renderFilters();
  setTitle("Favoritos");
  els.count.textContent = "";
  setStatus("Abrindo a coleção…");

  let result;
  try {
    result = await window.lookbook.favorites.list();
  } catch {
    result = { ok: false, error: "unknown" };
  }

  if (mine !== state.requestId || state.mode !== "favorites") return;

  if (!result.ok) {
    els.grid.replaceChildren();
    setStatus(errorText(result.error), {
      error: true,
      actions: [{ label: "Abrir pasta", onClick: openFolder }],
    });
    return;
  }

  state.favorites = result.items;
  state.favoriteIds = new Set(result.items.map((entry) => entry.id));
  if (result.dir) state.favoriteDir = result.dir;

  renderFilters();
  renderFavorites();
}

/* ---------- grade ---------- */

function renderSkeletons() {
  els.grid.setAttribute("aria-busy", "true");
  els.grid.replaceChildren();
  const ratios = ["3 / 4", "4 / 5", "2 / 3", "1 / 1", "3 / 4", "4 / 5", "2 / 3", "3 / 4"];

  for (const ratio of ratios) {
    const item = document.createElement("li");
    const block = document.createElement("div");
    block.className = "skeleton";
    block.style.setProperty("--ar", ratio);
    item.append(block);
    els.grid.append(item);
  }
}

function createPhotoItem(photo) {
  const item = document.createElement("li");
  item.dataset.id = photo.id;

  const link = document.createElement("a");
  link.className = "photo";
  link.href = photo.link || "#";
  link.target = "_blank";
  link.rel = "noreferrer";
  link.setAttribute("aria-label", photo.title || "Abrir look no Pinterest");

  const img = document.createElement("img");
  img.src = photo.thumb;
  img.alt = photo.title || "";
  img.loading = "lazy";
  img.decoding = "async";
  if (photo.width && photo.height) {
    img.style.setProperty("--ar", `${photo.width} / ${photo.height}`);
  }

  img.addEventListener("load", () => item.classList.add("is-loaded"), { once: true });
  // Na coleção, imagem quebrada some do grid; o índice avisa na linha de status.
  img.addEventListener("error", () => item.remove(), { once: true });

  link.append(img);
  item.append(link, createSaveButton(photo));
  return item;
}

function renderPhotos(photos) {
  const fragment = document.createDocumentFragment();
  for (const photo of photos) fragment.append(createPhotoItem(photo));
  els.grid.replaceChildren(fragment);
  els.grid.removeAttribute("aria-busy");
}

/* ---------- nichos ---------- */

function prefetchOthers(currentId) {
  if (prefetched) return;
  prefetched = true;

  window.setTimeout(() => {
    for (const niche of state.niches) {
      if (niche.id !== currentId) window.lookbook.feed(niche.id).catch(() => {});
    }
  }, 2500);
}

async function selectNiche(nicheId) {
  const niche = state.niches.find((item) => item.id === nicheId);
  if (!niche) return;

  const mine = ++state.requestId;
  state.mode = "niche";
  state.currentId = nicheId;
  renderFilters();
  setTitle(niche.label);
  els.count.textContent = "";
  setStatus("Buscando looks…");

  // Esqueleto só se a resposta demorar: cache quente não pisca.
  const skeletonTimer = window.setTimeout(() => {
    if (mine === state.requestId && state.mode === "niche") renderSkeletons();
  }, 250);

  let result;
  try {
    result = await window.lookbook.feed(nicheId);
  } catch {
    result = { ok: false, error: "unknown" };
  }
  window.clearTimeout(skeletonTimer);

  if (mine !== state.requestId || state.mode !== "niche") return; // resposta velha

  if (!result.ok) {
    els.grid.replaceChildren();
    els.grid.removeAttribute("aria-busy");
    setStatus(errorText(result.error), {
      error: true,
      actions: RETRYABLE.has(result.error)
        ? [{ label: "Tentar de novo", onClick: () => selectNiche(nicheId) }]
        : [],
    });
    return;
  }

  renderPhotos(result.photos);
  els.count.textContent = `${result.photos.length} fotos`;
  setStatus("");
  prefetchOthers(nicheId);
}

async function boot() {
  let niches;
  let favorites;

  try {
    [niches, favorites] = await Promise.all([
      window.lookbook.niches(),
      window.lookbook.favorites.list(),
    ]);
  } catch {
    setStatus("Não foi possível iniciar o Lookbook.", { error: true });
    return;
  }

  state.niches = niches;
  if (favorites?.ok) {
    state.favorites = favorites.items;
    state.favoriteIds = new Set(favorites.items.map((entry) => entry.id));
    if (favorites.dir) state.favoriteDir = favorites.dir;
  }

  if (!state.niches.length) {
    setStatus(errorText("config_missing"), { error: true });
    return;
  }

  renderFilters();
  selectNiche(state.niches[0].id);
}

boot();