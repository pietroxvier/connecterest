"use strict";
// Serve as imagens dos favoritos em lookbook://fav/<arquivo>.
// O esquema é registrado no require (precisa ser antes do app ficar pronto).

const path = require("node:path");
const fs = require("node:fs/promises");
const { protocol } = require("electron");
const { resolveFavoritesPath, INDEX_NAME } = require("./favorites");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "lookbook",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function serveFavorites(dir) {
  protocol.handle("lookbook", async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "fav") return new Response("not found", { status: 404 });

    const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (name === INDEX_NAME) return new Response("forbidden", { status: 403 });

    const file = resolveFavoritesPath(dir, name);
    if (!file) return new Response("forbidden", { status: 403 });

    try {
      const data = await fs.readFile(file);
      return new Response(data, {
        headers: {
          "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
          "cache-control": "public, max-age=86400",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

module.exports = { serveFavorites };