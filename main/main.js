"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { app, BrowserWindow, shell, dialog } = require("electron");
const { createLookbook } = require("./lookbook");
const { createFavorites } = require("./favorites");
const { downloadToFile } = require("./pinterest");
const { registerLookbookIpc } = require("./ipc");
const { favoritesDir } = require("./paths");
const { serveFavorites } = require("./protocol");

// `npm run smoke` sobe o app, busca um nicho de verdade e sai.
const IS_SMOKE = process.argv.includes("--smoke");

// getPath() não é confiável antes do ready ("Failed to get 'pictures' path"),
// então nada de caminho no topo do módulo.
function resolvePaths() {
  const root = app.getAppPath();

  return {
    config: path.join(root, "keywords.json"),
    cache: path.join(app.getPath("userData"), "pinterest-cache"),
    icon: path.join(root, "assets", "icon.ico"),
    favorites: favoritesDir(app),
  };
}

function createWindow(iconPath) {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 420,
    backgroundColor: "#FAFAF8",
    icon: iconPath,
    title: "Lookbook",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Links de pin abrem no navegador, nunca dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return win;
}

async function runSmoke(lookbook, favorites, favoritesDirPath) {
  const started = Date.now();
  try {
    const niches = lookbook.niches();
    console.log(`nichos: ${niches.map((n) => n.id).join(", ")}`);

    const photos = await lookbook.feed(niches[0].id);
    console.log(`feed "${niches[0].id}": ${photos.length} fotos em ${Date.now() - started} ms`);
    if (!photos.length) throw new Error("feed vazio");

    const unique = new Set(photos.map((p) => p.id)).size === photos.length;
    if (!unique) throw new Error("ids duplicados no feed");
    if (!photos.every((p) => p.image.startsWith("https://"))) {
      throw new Error("alguma foto sem URL https");
    }

    // Ciclo completo de favorito: baixa arquivo, grava índice, remove.
    // Nunca remover algo que o usuário já tinha salvo.
    const before = await favorites.list();
    const savedIds = new Set(before.map((entry) => entry.id));
    const target = photos.find((photo) => !savedIds.has(photo.id));
    if (!target) throw new Error("todas as fotos do feed já são favoritas");

    const saved = await favorites.add(target, { niche: niches[0].id });
    const stat = await fs.stat(path.join(favoritesDirPath, saved.file));
    const listed = await favorites.list();
    console.log(`favorito: ${saved.file} (${stat.size} bytes), ${listed.length} no índice`);

    const removed = await favorites.remove(target.id);
    const trashed = await fs.stat(path.join(favoritesDirPath, "lixeira", removed.file));
    console.log(`removido para a lixeira (${trashed.size} bytes)`);

    const restored = await favorites.restore(removed);
    await fs.stat(path.join(favoritesDirPath, removed.file));
    console.log(`desfazer funcionou: ${restored}`);

    // Limpa o que o teste criou, sem tocar no que já era do usuário.
    await favorites.remove(target.id);
    await fs.unlink(path.join(favoritesDirPath, "lixeira", removed.file)).catch(() => {});

    console.log(`SMOKE OK em ${Date.now() - started} ms`);
    app.exit(0);
  } catch (e) {
    console.error(`SMOKE FALHOU: ${e.code || ""} ${e.message}`);
    app.exit(1);
  }
}

app.whenReady().then(() => {
  const paths = resolvePaths();

  let lookbook;
  let favorites;

  try {
    lookbook = createLookbook({ cacheDir: paths.cache, configPath: paths.config });
    favorites = createFavorites({ dir: paths.favorites, download: downloadToFile });
  } catch (e) {
    // Sem janela não há tela para mostrar o erro: precisa de diálogo.
    dialog.showErrorBox(
      "O Lookbook não conseguiu abrir",
      "A lista de filtros está danificada ou faltando.\n\n" +
        `Detalhe técnico: ${e.message}\n\n` +
        "Peça para quem instalou conferir o arquivo keywords.json na pasta do app."
    );
    app.exit(1);
    return;
  }

  serveFavorites(paths.favorites);

  if (IS_SMOKE) {
    runSmoke(lookbook, favorites, paths.favorites);
    return;
  }

  registerLookbookIpc({ lookbook, favorites });
  createWindow(paths.icon);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(paths.icon);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});