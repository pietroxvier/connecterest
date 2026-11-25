"use strict";
// Funções puras: nada de rede, nada de disco. É o que os testes cobrem.

const RESOURCE = "https://www.pinterest.com/resource/BaseSearchResource/get/";

function pinterestError(code, detail) {
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  return err;
}

/**
 * Monta a URL da busca interna.
 * ATENÇÃO: paginação usa `options.bookmarks` (array). `options.bookmark`
 * sozinho é silenciosamente ignorado e devolve a página 1 de novo.
 */
function buildSearchUrl(query, { pageSize = 50, bookmark = null } = {}) {
  if (typeof query !== "string" || !query.trim()) {
    throw pinterestError("invalid_query");
  }

  const options = {
    query: query.trim(),
    scope: "pins",
    page_size: Math.min(Math.max(Number(pageSize) || 50, 1), 250),
  };
  if (bookmark) options.bookmarks = [bookmark];

  const sourceUrl = `/search/pins/?q=${encodeURIComponent(options.query)}`;
  const data = encodeURIComponent(JSON.stringify({ options, context: {} }));

  return {
    url: `${RESOURCE}?source_url=${encodeURIComponent(sourceUrl)}&data=${data}`,
    referer: `https://www.pinterest.com${sourceUrl}`,
  };
}

/** Converte um pin bruto do Pinterest em foto. Devolve null se não houver imagem. */
function toPhoto(pin) {
  if (!pin || pin.type !== "pin") return null;

  const img = pin.images?.orig ?? pin.images?.["736x"];
  if (!img?.url) return null;

  return {
    id: pin.id,
    image: img.url,
    thumb: pin.images?.["474x"]?.url ?? img.url,
    width: img.width ?? null,
    height: img.height ?? null,
    title: pin.title || pin.grid_title || "",
    description: pin.description || "",
    link: pin.link || `https://www.pinterest.com/pin/${pin.id}/`,
    author: pin.pinner?.username ?? null,
  };
}

/**
 * Lê uma resposta do endpoint de busca.
 * Devolve { photos, bookmark, sensitivity }.
 * `sensitivity` preenchido + 0 fotos = o Pinterest barrou a query nesta região.
 */
function parseSearchResponse(json) {
  const rr = json?.resource_response;
  if (!rr) throw pinterestError("bad_response", "sem resource_response");
  if (rr.status !== "success") {
    throw pinterestError("pinterest_error", rr.message || rr.status);
  }

  const photos = [];
  const seen = new Set();
  for (const pin of rr.data?.results ?? []) {
    const photo = toPhoto(pin);
    if (!photo || seen.has(photo.id)) continue;
    seen.add(photo.id);
    photos.push(photo);
  }

  return {
    photos,
    bookmark: rr.bookmark ?? null,
    sensitivity: rr.data?.sensitivity ?? null,
  };
}

/** Intercala listas para o grid não ficar em blocos por query. */
function interleave(buckets, limit = 36) {
  const out = [];
  const seen = new Set();
  const maxLen = Math.max(0, ...buckets.map((b) => b.length));

  for (let i = 0; i < maxLen && out.length < limit; i++) {
    for (const bucket of buckets) {
      const photo = bucket[i];
      if (!photo || seen.has(photo.id)) continue;
      seen.add(photo.id);
      out.push(photo);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Valida keywords.json e devolve a lista de nichos. */
function parseNiches(raw) {
  const list = raw?.niches;
  if (!Array.isArray(list) || list.length === 0) {
    throw pinterestError("invalid_config", "keywords.json precisa de um array 'niches'");
  }

  const seen = new Set();
  return list.map((niche, index) => {
    const id = niche?.id;
    if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id)) {
      throw pinterestError(
        "invalid_config",
        `nicho #${index} precisa de 'id' em minúsculas com hífen`
      );
    }
    if (seen.has(id)) throw pinterestError("invalid_config", `id duplicado: ${id}`);
    seen.add(id);

    if (typeof niche.label !== "string" || !niche.label.trim()) {
      throw pinterestError("invalid_config", `nicho '${id}' precisa de 'label'`);
    }
    if (!Array.isArray(niche.queries) || niche.queries.length === 0) {
      throw pinterestError("invalid_config", `nicho '${id}' precisa de 'queries'`);
    }

    const queries = niche.queries
      .filter((q) => typeof q === "string" && q.trim())
      .map((q) => q.trim());

    if (queries.length === 0) {
      throw pinterestError("invalid_config", `nicho '${id}' tem queries vazias`);
    }

    return { id, label: niche.label.trim(), queries };
  });
}

module.exports = {
  RESOURCE,
  pinterestError,
  buildSearchUrl,
  toPhoto,
  parseSearchResponse,
  interleave,
  parseNiches,
};