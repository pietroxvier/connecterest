"use strict";
// Testes offline: usam as fixtures salvas, não tocam na rede.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildSearchUrl,
  parseSearchResponse,
  interleave,
  parseNiches,
} = require("../main/lib");
const { createLookbook } = require("../main/lookbook");

const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));

const CONFIG = path.join(__dirname, "..", "keywords.json");

test("paginação usa options.bookmarks como array", () => {
  const { url } = buildSearchUrl("gothic outfit", { bookmark: "ABC123" });
  const data = JSON.parse(new URL(url).searchParams.get("data"));

  // Regressão: com `bookmark` singular o Pinterest devolve a página 1 de novo.
  assert.deepEqual(data.options.bookmarks, ["ABC123"]);
  assert.equal(data.options.bookmark, undefined);
});

test("sem bookmark não manda bookmarks", () => {
  const { url } = buildSearchUrl("gothic outfit");
  const data = JSON.parse(new URL(url).searchParams.get("data"));
  assert.equal(data.options.bookmarks, undefined);
});

test("page_size é limitado a 250", () => {
  const { url } = buildSearchUrl("x", { pageSize: 900 });
  const data = JSON.parse(new URL(url).searchParams.get("data"));
  assert.equal(data.options.page_size, 250);
});

test("query vazia é rejeitada", () => {
  assert.throws(() => buildSearchUrl("   "), /invalid_query/);
});

test("resposta com pins vira lista de fotos válidas", () => {
  const { photos, bookmark } = parseSearchResponse(fixture("search-ok.json"));

  assert.ok(photos.length > 0, "esperava pelo menos uma foto");
  assert.equal(new Set(photos.map((p) => p.id)).size, photos.length, "ids duplicados");
  assert.ok(photos.every((p) => p.image.startsWith("https://")), "URL não-https");
  assert.ok(photos.every((p) => p.width > 0 && p.height > 0), "foto sem dimensões");
  assert.ok(photos.every((p) => p.thumb.startsWith("https://i.pinimg.com")), "thumb fora do CDN");
  assert.equal(typeof bookmark, "string");
});

test("query bloqueada devolve zero fotos e sensitivity", () => {
  const { photos, sensitivity } = parseSearchResponse(fixture("search-empty.json"));

  assert.equal(photos.length, 0);
  assert.ok(sensitivity && typeof sensitivity === "object", "esperava objeto sensitivity");
});

test("status diferente de success lança erro", () => {
  assert.throws(
    () => parseSearchResponse({ resource_response: { status: "error", message: "boom" } }),
    /pinterest_error/
  );
});

test("resposta sem resource_response lança bad_response", () => {
  assert.throws(() => parseSearchResponse({}), /bad_response/);
});

test("interleave alterna e remove duplicados", () => {
  const a = [{ id: "1" }, { id: "2" }, { id: "3" }];
  const b = [{ id: "2" }, { id: "4" }];

  assert.deepEqual(
    interleave([a, b], 10).map((p) => p.id),
    ["1", "2", "4", "3"]
  );
  assert.equal(interleave([a, b], 2).length, 2);
});

test("keywords.json é válido", () => {
  const niches = parseNiches(JSON.parse(fs.readFileSync(CONFIG, "utf8")));
  assert.ok(niches.length >= 1);
  assert.ok(niches.every((n) => n.queries.length > 0));
});

test("config inválida é rejeitada com mensagem clara", () => {
  assert.throws(() => parseNiches({ niches: [] }), /invalid_config/);
  assert.throws(
    () => parseNiches({ niches: [{ id: "Ok", label: "x", queries: ["a"] }] }),
    /invalid_config/
  );
  assert.throws(
    () =>
      parseNiches({
        niches: [
          { id: "a", label: "A", queries: ["x"] },
          { id: "a", label: "B", queries: ["y"] },
        ],
      }),
    /duplicado/
  );
});

test("lookbook: nicho desconhecido não chama o transporte", async () => {
  let called = false;
  const lookbook = createLookbook({
    configPath: CONFIG,
    transport: {
      feed: async () => {
        called = true;
        return [];
      },
    },
  });

  await assert.rejects(() => lookbook.feed("nao-existe"), /unknown_niche/);
  assert.equal(called, false);
});

test("lookbook: feed repassa as queries do nicho", async () => {
  let received = null;
  const lookbook = createLookbook({
    configPath: CONFIG,
    transport: {
      feed: async (queries, opts) => {
        received = { queries, opts };
        return [{ id: "p1" }];
      },
    },
  });

  const niches = lookbook.niches();
  const photos = await lookbook.feed(niches[0].id, { limit: 5, perQuery: 2 });

  assert.equal(photos.length, 1);
  assert.ok(Array.isArray(received.queries) && received.queries.length > 0);
  assert.deepEqual(received.opts, { limit: 5, perQuery: 2 });
});

/* ---------- favoritos ---------- */

const fsPromises = require("node:fs/promises");
const os = require("node:os");
const {
  createFavorites,
  resolveFavoritesPath,
  preferredImageUrl,
  imageVariants,
  extensionFor,
} = require("../main/favorites");

const PHOTO = {
  id: "123_abc-def",
  image: "https://i.pinimg.com/originals/aa/bb/cc.jpg",
  thumb: "https://i.pinimg.com/474x/aa/bb/cc.jpg",
  title: "Look preto",
  link: "https://www.pinterest.com/pin/123/",
  author: "alguem",
  width: 1080,
  height: 1920,
};

async function tempDir() {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), "lookbook-fav-"));
}

// Download falso: grava 3 bytes, sem rede.
const fakeDownload = async (url, dest) => {
  await fsPromises.mkdir(path.dirname(dest), { recursive: true });
  await fsPromises.writeFile(dest, Buffer.from("img"));
};

test("favorito grava imagem e índice", async () => {
  const dir = await tempDir();
  const favorites = createFavorites({ dir, download: fakeDownload });

  const entry = await favorites.add(PHOTO, { niche: "gotico" });

  assert.equal(entry.id, PHOTO.id);
  assert.equal(entry.niche, "gotico");
  assert.equal((await fsPromises.stat(path.join(dir, entry.file))).size, 3);

  const listed = await favorites.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, PHOTO.id);
  assert.ok(await favorites.has(PHOTO.id));
});

test("favoritar duas vezes não duplica", async () => {
  const dir = await tempDir();
  const favorites = createFavorites({ dir, download: fakeDownload });

  await favorites.add(PHOTO, { niche: "gotico" });
  await favorites.add(PHOTO, { niche: "gotico" });

  assert.equal((await favorites.list()).length, 1);
});

test("remover move o arquivo para a lixeira, não apaga", async () => {
  const dir = await tempDir();
  const favorites = createFavorites({ dir, download: fakeDownload });

  const entry = await favorites.add(PHOTO, { niche: "gotico" });
  const removed = await favorites.remove(PHOTO.id);

  assert.equal(removed.id, PHOTO.id, "devolve a entrada para permitir desfazer");
  assert.equal((await favorites.list()).length, 0);
  await assert.rejects(() => fsPromises.stat(path.join(dir, entry.file)));

  const trashed = await fsPromises.stat(path.join(dir, "lixeira", entry.file));
  assert.ok(trashed.size > 0, "arquivo deveria estar na lixeira");

  assert.equal(await favorites.remove("nao-existe"), null);
});

test("desfazer traz o look de volta do lixeira", async () => {
  const dir = await tempDir();
  const favorites = createFavorites({ dir, download: fakeDownload });

  const entry = await favorites.add(PHOTO, { niche: "gotico" });
  const removed = await favorites.remove(PHOTO.id);

  assert.equal(await favorites.restore(removed), true);
  assert.equal((await favorites.list()).length, 1);
  assert.ok((await fsPromises.stat(path.join(dir, entry.file))).size > 0);
});

test("desfazer falha se o arquivo sumiu de vez", async () => {
  const dir = await tempDir();
  const favorites = createFavorites({ dir, download: fakeDownload });

  const entry = await favorites.add(PHOTO, { niche: "gotico" });
  const removed = await favorites.remove(PHOTO.id);
  await fsPromises.unlink(path.join(dir, "lixeira", entry.file));

  assert.equal(await favorites.restore(removed), false);
  assert.equal((await favorites.list()).length, 0);
});

test("list marca arquivo que sumiu da pasta", async () => {
  const dir = await tempDir();
  const favorites = createFavorites({ dir, download: fakeDownload });

  const entry = await favorites.add(PHOTO, { niche: "gotico" });
  await fsPromises.unlink(path.join(dir, entry.file));

  const [item] = await favorites.list();
  assert.equal(item.missing, true);
  assert.equal(item.id, PHOTO.id);
});

test("índice corrompido é preservado, não sobrescrito", async () => {
  const dir = await tempDir();
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(path.join(dir, "favoritos.json"), "{ isto não é json", "utf8");

  const favorites = createFavorites({ dir, download: fakeDownload });
  await assert.rejects(() => favorites.list(), /index_unreadable/);

  const files = await fsPromises.readdir(dir);
  assert.ok(
    files.some((name) => name.startsWith("favoritos.json.quebrado-")),
    "o índice quebrado deveria ser guardado com outro nome"
  );
});

test("índice sobrevive a reinício do app", async () => {
  const dir = await tempDir();
  await createFavorites({ dir, download: fakeDownload }).add(PHOTO, { niche: "gotico" });

  const reopened = createFavorites({ dir, download: fakeDownload });
  const listed = await reopened.list();

  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, "Look preto");
});

test("path traversal é bloqueado", () => {
  const dir = path.join(os.tmpdir(), "lookbook-root");
  assert.equal(resolveFavoritesPath(dir, "ok.jpg"), path.join(path.resolve(dir), "ok.jpg"));
  assert.equal(resolveFavoritesPath(dir, "../../windows/system32/x.dll"), null);
  assert.equal(resolveFavoritesPath(dir, "..\\..\\segredo.txt"), null);
});

test("favorito usa 736x em vez do original", () => {
  assert.equal(
    preferredImageUrl(PHOTO),
    "https://i.pinimg.com/736x/aa/bb/cc.jpg"
  );
  assert.equal(
    preferredImageUrl({ image: "https://i.pinimg.com/564x/x.jpg" }),
    "https://i.pinimg.com/564x/x.jpg"
  );
  assert.throws(() => preferredImageUrl({}), /no_image/);
});

test("se o 736x falhar, cai para o original", async () => {
  const dir = await tempDir();
  const tentativas = [];

  const download = async (url, dest) => {
    tentativas.push(url);
    if (url.includes("/736x/")) throw Object.assign(new Error("403"), { code: "image_http_error" });
    await fsPromises.mkdir(path.dirname(dest), { recursive: true });
    await fsPromises.writeFile(dest, Buffer.from("img"));
  };

  const favorites = createFavorites({ dir, download });
  const entry = await favorites.add(PHOTO, { niche: "gotico" });

  assert.deepEqual(tentativas, [
    "https://i.pinimg.com/736x/aa/bb/cc.jpg",
    "https://i.pinimg.com/originals/aa/bb/cc.jpg",
  ]);
  assert.ok(entry.file.endsWith(".jpg"));
});

test("imagem png mantém a extensão real", async () => {
  const dir = await tempDir();
  const favorites = createFavorites({ dir, download: fakeDownload });

  const entry = await favorites.add(
    { ...PHOTO, image: "https://i.pinimg.com/736x/aa/bb/cc.png" },
    { niche: "gotico" }
  );

  assert.ok(entry.file.endsWith(".png"), `esperava .png, veio ${entry.file}`);
});

test("variantes de imagem priorizam a leve", () => {
  assert.deepEqual(imageVariants(PHOTO), [
    "https://i.pinimg.com/736x/aa/bb/cc.jpg",
    "https://i.pinimg.com/originals/aa/bb/cc.jpg",
    "https://i.pinimg.com/474x/aa/bb/cc.jpg",
  ]);
  assert.equal(extensionFor("https://x/y/arquivo.PNG"), ".png");
  assert.equal(extensionFor("https://x/y/sem-extensao"), ".jpg");
});

test("favorito sem id é rejeitado", async () => {
  const dir = await tempDir();
  const favorites = createFavorites({ dir, download: fakeDownload });
  await assert.rejects(() => favorites.add({}), /invalid_photo/);
});