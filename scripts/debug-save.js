"use strict";
// Diagnóstico: tenta salvar as primeiras fotos e mostra o erro de cada uma.
const os = require("node:os");
const path = require("node:path");
const { createPinterest, downloadToFile } = require("../main/pinterest");
const { createFavorites } = require("../main/favorites");

(async () => {
  const pinterest = createPinterest({
    cacheDir: path.join(os.tmpdir(), "pinterest-looks-live-test"),
    minIntervalMs: 700,
  });
  const favorites = createFavorites({
    dir: path.join(os.tmpdir(), "lookbook-debug-save"),
    download: downloadToFile,
  });

  const photos = await pinterest.search("gothic outfit", { limit: 6 });
  console.log(`fotos: ${photos.length}`);

  for (const photo of photos.slice(0, 4)) {
    try {
      const entry = await favorites.add(photo, { niche: "gotico" });
      console.log(`ok   ${photo.id.slice(0, 18)}  ${entry.file.slice(-30)}`);
    } catch (e) {
      const url = photo.image.replace("/originals/", "/736x/");
      console.log(`FALHA ${photo.id.slice(0, 18)}  ${e.code || "?"} ${e.message}`);
      console.log(`      ${url}`);
    }
  }
})();