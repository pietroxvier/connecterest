"use strict";
// Teste que toca a rede de verdade. Rode com: npm run test:live
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { createPinterest } = require("../main/pinterest");

const cacheDir = path.join(os.tmpdir(), "pinterest-looks-live-test");

test("busca real devolve fotos", { timeout: 60000 }, async () => {
  const pinterest = createPinterest({ cacheDir, minIntervalMs: 700 });

  const query = `live test ${process.pid} ${Date.now()}`;
  const photos = await pinterest.search("gothic outfit", { limit: 12 });

  assert.ok(photos.length > 0, "esperava fotos do Pinterest real");
  assert.ok(photos.every((p) => p.image.startsWith("https://")));
  assert.equal(new Set(photos.map((p) => p.id)).size, photos.length);
  assert.ok(query.length > 0);
});

test("fallback cobre query bloqueada", { timeout: 90000 }, async () => {
  const pinterest = createPinterest({ cacheDir, minIntervalMs: 700 });
  const photos = await pinterest.searchWithFallback("coquette aesthetic", { limit: 8 });
  assert.ok(photos.length > 0, "fallback deveria achar fotos por variação da query");
});