"use strict";
// Favoritos: índice em JSON + imagem baixada para uma pasta visível do usuário.
// Remover NÃO apaga: move para <pasta>/lixeira, para dar desfazer.

const fs = require("node:fs/promises");
const path = require("node:path");
const { pinterestError } = require("./lib");

const INDEX_NAME = "favoritos.json";
const TRASH_NAME = "lixeira";

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "look";
}

/** Resolve um nome de arquivo dentro da pasta, bloqueando path traversal. */
function resolveFavoritesPath(dir, filename) {
  const root = path.resolve(dir);
  const target = path.resolve(root, filename);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/** 736x é o melhor custo/qualidade: ~10x menor que o original e bom na tela. */
function preferredImageUrl(photo) {
  const url = photo?.image || photo?.thumb;
  if (!url) throw pinterestError("no_image");
  return url.includes("/originals/") ? url.replace("/originals/", "/736x/") : url;
}

/**
 * URLs para tentar, em ordem. Alguns pins são .png e a variante 736x
 * responde 403 neles, então o original precisa ser o plano B.
 */
function imageVariants(photo) {
  const base = photo?.image || photo?.thumb;
  if (!base) throw pinterestError("no_image");

  const list = [];
  if (base.includes("/originals/")) list.push(base.replace("/originals/", "/736x/"));
  list.push(base);
  if (photo?.thumb) list.push(photo.thumb);

  return [...new Set(list)];
}

function extensionFor(url) {
  let ext = "";
  try {
    ext = path.extname(new URL(url).pathname).toLowerCase();
  } catch {
    /* url estranha, usa o padrão */
  }
  return [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
}

function createFavorites({ dir, download }) {
  if (!dir) throw new Error("dir é obrigatório");
  if (typeof download !== "function") throw new Error("download é obrigatório");

  const indexPath = path.join(dir, INDEX_NAME);
  const trashDir = path.join(dir, TRASH_NAME);

  let entries = [];
  let loaded = false;
  let chain = Promise.resolve();

  async function load() {
    if (loaded) return;

    let raw;
    try {
      raw = await fs.readFile(indexPath, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") {
        entries = []; // primeira execução, normal
        loaded = true;
        return;
      }
      throw pinterestError("index_unreadable", e.message);
    }

    try {
      const parsed = JSON.parse(raw);
      entries = Array.isArray(parsed?.items) ? parsed.items : [];
    } catch (e) {
      // Índice corrompido: preserva o arquivo em vez de sobrescrever a coleção.
      const broken = `${indexPath}.quebrado-${Date.now()}`;
      await fs.rename(indexPath, broken).catch(() => {});
      throw pinterestError("index_unreadable", `índice guardado em ${path.basename(broken)}`);
    }

    loaded = true;
  }

  async function persist() {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${indexPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, items: entries }, null, 2), "utf8");
    await fs.rename(tmp, indexPath); // atômico
  }

  // Serializa add/remove/restore: duas ações rápidas não podem corromper o índice.
  function serialize(fn) {
    const run = chain.then(fn);
    chain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  return {
    dir,

    async list() {
      await chain; // não devolve estado antigo no meio de uma gravação
      await load();

      const items = [];
      for (const entry of entries) {
        let missing = false;
        const file = resolveFavoritesPath(dir, entry.file);
        try {
          await fs.stat(file);
        } catch {
          missing = true;
        }
        items.push({ ...entry, missing });
      }

      return items.sort((a, b) => b.savedAt - a.savedAt);
    },

    async has(id) {
      await load();
      return entries.some((entry) => entry.id === id);
    },

    add(photo, { niche = null } = {}) {
      if (!photo?.id) return Promise.reject(pinterestError("invalid_photo"));

      return serialize(async () => {
        await load();

        const existing = entries.find((entry) => entry.id === photo.id);
        if (existing) return existing; // idempotente

        // Tenta a variante leve e cai para o original se o CDN recusar.
        let file = "";
        let lastError = null;

        for (const url of imageVariants(photo)) {
          const candidate = `${safeId(photo.id)}${extensionFor(url)}`;
          try {
            await download(url, path.join(dir, candidate));
            file = candidate;
            break;
          } catch (e) {
            lastError = e;
          }
        }

        if (!file) throw lastError || pinterestError("no_image");

        const entry = {
          id: photo.id,
          file,
          title: photo.title ?? "",
          link: photo.link ?? "",
          author: photo.author ?? null,
          niche,
          width: photo.width ?? null,
          height: photo.height ?? null,
          savedAt: Date.now(),
        };

        entries.push(entry);
        await persist();
        return entry;
      });
    },

    /** Move o arquivo para a lixeira. Devolve a entrada removida (para desfazer). */
    remove(id) {
      return serialize(async () => {
        await load();

        const index = entries.findIndex((entry) => entry.id === id);
        if (index === -1) return null;

        const [entry] = entries.splice(index, 1);
        const source = resolveFavoritesPath(dir, entry.file);

        if (source) {
          try {
            await fs.mkdir(trashDir, { recursive: true });
            const dest = path.join(trashDir, entry.file);
            await fs.unlink(dest).catch(() => {});
            await fs.rename(source, dest);
          } catch {
            await fs.unlink(source).catch(() => {});
          }
        }

        await persist();
        return entry;
      });
    },

    /** Traz de volta um favorito removido, se o arquivo ainda estiver na lixeira. */
    restore(entry) {
      if (!entry?.id) return Promise.reject(pinterestError("invalid_photo"));

      return serialize(async () => {
        await load();
        if (entries.some((item) => item.id === entry.id)) return true;

        const target = resolveFavoritesPath(dir, entry.file);
        if (!target) return false;

        let exists = true;
        try {
          await fs.stat(target);
        } catch {
          exists = false;
        }

        if (!exists) {
          const from = path.join(trashDir, entry.file);
          try {
            await fs.rename(from, target);
          } catch {
            return false;
          }
        }

        entries.push(entry);
        await persist();
        return true;
      });
    },
  };
}

module.exports = {
  createFavorites,
  resolveFavoritesPath,
  preferredImageUrl,
  imageVariants,
  extensionFor,
  INDEX_NAME,
  TRASH_NAME,
};