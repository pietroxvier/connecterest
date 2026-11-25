"use strict";
// Camada de rede + cache em disco. Roda no main process (o renderer não pode:
// o Pinterest não manda header CORS).

const https = require("node:https");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildSearchUrl, parseSearchResponse, interleave, pinterestError } = require("./lib");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DEFAULT_MIN_INTERVAL_MS = 900;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// Query bloqueada não pode ficar 6h em cache: talvez volte a funcionar.
const EMPTY_CACHE_TTL_MS = 10 * 60 * 1000;

function httpGetJson(url, referer, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json, text/javascript, */*, q=0.01",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
          "X-Pinterest-PWS-Handler": "www/index.js",
          "X-Requested-With": "XMLHttpRequest",
          Referer: referer,
        },
        timeout: 15000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
          res.resume();
          resolve(
            httpGetJson(new URL(res.headers.location, url).toString(), referer, redirects + 1)
          );
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(
            pinterestError(res.statusCode === 429 ? "rate_limited" : "http_error", String(res.statusCode))
          );
          return;
        }

        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(pinterestError("bad_json"));
          }
        });
      }
    );

    req.on("timeout", () => req.destroy(pinterestError("timeout")));
    req.on("error", (e) => reject(pinterestError(e.code || "network_error", e.message)));
  });
}

function createPinterest({
  cacheDir,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
} = {}) {
  if (!cacheDir) throw new Error("cacheDir é obrigatório");

  let chain = Promise.resolve();
  let lastRequestAt = 0;
  const inflight = new Map();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Serializa e espaça as requisições. Sem isso o Pinterest começa a devolver 429.
  function throttled(fn) {
    const run = chain.then(async () => {
      const wait = minIntervalMs + Math.random() * 300 - (Date.now() - lastRequestAt);
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();
      return fn();
    });
    chain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  const cacheFile = (key) =>
    path.join(cacheDir, `${crypto.createHash("sha1").update(key).digest("hex")}.json`);

  async function readCache(key) {
    try {
      const entry = JSON.parse(await fs.readFile(cacheFile(key), "utf8"));
      if (entry.expires > Date.now()) return entry.value;
    } catch {
      /* cache miss */
    }
    return null;
  }

  async function writeCache(key, value, ttl) {
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      const file = cacheFile(key);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ expires: Date.now() + ttl, value }), "utf8");
      await fs.rename(tmp, file); // atômico: evita JSON corrompido se o app fechar no meio
    } catch {
      /* cache é best-effort */
    }
  }

  async function fetchQuery(query, { limit = 40, pageSize = 50 } = {}) {
    const photos = [];
    const seen = new Set();
    let bookmark = null;

    while (photos.length < limit) {
      const { url, referer } = buildSearchUrl(query, { pageSize, bookmark });

      let json;
      try {
        json = await throttled(() => httpGetJson(url, referer));
      } catch (e) {
        if (e.code !== "rate_limited") throw e;
        await sleep(3000); // uma segunda chance, mais devagar
        json = await throttled(() => httpGetJson(url, referer));
      }

      const page = parseSearchResponse(json);
      for (const photo of page.photos) {
        if (seen.has(photo.id)) continue;
        seen.add(photo.id);
        photos.push(photo);
        if (photos.length >= limit) break;
      }

      if (!page.bookmark) break;
      bookmark = page.bookmark;
    }

    return photos.slice(0, limit);
  }

  async function search(query, { limit = 40, pageSize = 50 } = {}) {
    const key = `v2|${query}|${limit}`;
    const cached = await readCache(key);
    if (cached !== null) return cached;
    if (inflight.has(key)) return inflight.get(key);

    const job = (async () => {
      const value = await fetchQuery(query, { limit, pageSize });
      await writeCache(key, value, value.length ? cacheTtlMs : EMPTY_CACHE_TTL_MS);
      return value;
    })();

    inflight.set(key, job);
    try {
      return await job;
    } finally {
      inflight.delete(key);
    }
  }

  // Se a query exata vier vazia (bloqueio regional), tenta variantes.
  async function searchWithFallback(query, opts = {}) {
    for (const variant of new Set([query, `${query} outfit`, `${query} aesthetic`])) {
      const photos = await search(variant, opts);
      if (photos.length) return photos;
    }
    return [];
  }

  // Várias queries do mesmo nicho -> um grid único e variado.
  async function feed(queries, { limit = 36, perQuery = 18 } = {}) {
    const buckets = [];
    for (const query of queries) {
      try {
        buckets.push(await searchWithFallback(query, { limit: perQuery }));
      } catch (e) {
        if (e.code === "rate_limited") break;
        // uma query com problema não derruba o feed inteiro
      }
    }
    return interleave(buckets, limit);
  }

  return { search, searchWithFallback, feed };
}

/** Baixa uma imagem para disco. Grava em .tmp e renomeia (atômico). */
function downloadToFile(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Referer: "https://www.pinterest.com/",
          Accept: "image/avif,image/webp,image/jpeg,image/*,*/*;q=0.8",
        },
        timeout: 20000,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirects < 3
        ) {
          res.resume();
          resolve(downloadToFile(new URL(res.headers.location, url).toString(), destPath, redirects + 1));
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(pinterestError("image_http_error", String(res.statusCode)));
          return;
        }

        const type = String(res.headers["content-type"] || "");
        if (type && !type.startsWith("image/")) {
          res.resume();
          reject(pinterestError("image_not_an_image", type));
          return;
        }

        const tmp = `${destPath}.${process.pid}.tmp`;
        fs.mkdir(path.dirname(destPath), { recursive: true })
          .then(
            () =>
              new Promise((done, fail) => {
                const out = fsSync.createWriteStream(tmp);
                res.pipe(out);
                res.on("error", fail);
                out.on("error", fail);
                out.on("finish", () => done());
              })
          )
          .then(() => fs.rename(tmp, destPath))
          .then(resolve)
          .catch((e) => fs.unlink(tmp).catch(() => {}).then(() => reject(e)));
      }
    );

    req.on("timeout", () => req.destroy(pinterestError("timeout")));
    req.on("error", (e) => reject(pinterestError(e.code || "network_error", e.message)));
  });
}

module.exports = { createPinterest, httpGetJson, downloadToFile };