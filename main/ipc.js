"use strict";
// Ponte IPC. O renderer manda só o id do nicho — nunca uma query crua.

const { ipcMain, shell } = require("electron");

// Só aceita os campos que sabemos usar. O renderer é código nosso, mas
// validar aqui evita gravar lixo no índice de favoritos.
function sanitizePhoto(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !raw.id) return null;

  const str = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

  return {
    id: raw.id.slice(0, 200),
    image: str(raw.image, 2000),
    thumb: str(raw.thumb, 2000),
    title: str(raw.title, 500),
    link: str(raw.link, 2000),
    author: str(raw.author, 200),
    width: Number(raw.width) || null,
    height: Number(raw.height) || null,
  };
}

function registerLookbookIpc({ lookbook, favorites }) {
  ipcMain.handle("lookbook:niches", () => lookbook.niches());

  ipcMain.handle("lookbook:feed", async (_event, nicheId) => {
    try {
      const photos = await lookbook.feed(nicheId);
      if (!photos.length) return { ok: false, error: "empty" };
      return { ok: true, photos };
    } catch (e) {
      // Error cruza o IPC como string inútil: devolvemos um objeto.
      return { ok: false, error: e.code || "unknown", detail: e.message };
    }
  });

  ipcMain.handle("lookbook:favorites:list", async () => {
    try {
      return { ok: true, items: await favorites.list(), dir: favorites.dir };
    } catch (e) {
      return { ok: false, error: e.code || "unknown", dir: favorites.dir };
    }
  });

  ipcMain.handle("lookbook:favorites:add", async (_event, payload) => {
    const photo = sanitizePhoto(payload?.photo);
    if (!photo) return { ok: false, error: "invalid_photo" };

    const niche = typeof payload?.niche === "string" ? payload.niche.slice(0, 60) : null;

    try {
      return { ok: true, item: await favorites.add(photo, { niche }) };
    } catch (e) {
      return { ok: false, error: e.code || "unknown" };
    }
  });

  ipcMain.handle("lookbook:favorites:remove", async (_event, id) => {
    if (typeof id !== "string" || !id) return { ok: false, error: "invalid_photo" };

    try {
      // Devolve a entrada removida para a tela poder oferecer "Desfazer".
      return { ok: true, removed: await favorites.remove(id) };
    } catch (e) {
      return { ok: false, error: e.code || "unknown" };
    }
  });

  ipcMain.handle("lookbook:favorites:restore", async (_event, entry) => {
    if (!entry || typeof entry.id !== "string" || typeof entry.file !== "string") {
      return { ok: false, error: "invalid_photo" };
    }

    try {
      return { ok: true, restored: await favorites.restore(entry) };
    } catch (e) {
      return { ok: false, error: e.code || "unknown" };
    }
  });

  ipcMain.handle("lookbook:favorites:open", async () => {
    const error = await shell.openPath(favorites.dir);
    return { ok: !error, error: error || null };
  });
}

module.exports = { registerLookbookIpc };