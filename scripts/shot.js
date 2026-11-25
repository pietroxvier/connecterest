"use strict";
// Ferramenta de desenvolvimento: abre o app, interage e tira prints.
// Uso:
//   npx electron scripts/shot.js --out=shot.png
//   npx electron scripts/shot.js --favorites=3 --out=shot-favoritos.png
//   npx electron scripts/shot.js --hover=2 --out=shot-hover.png

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow } = require("electron");
const { createLookbook } = require("../main/lookbook");
const { createFavorites } = require("../main/favorites");
const { downloadToFile } = require("../main/pinterest");
const { registerLookbookIpc } = require("../main/ipc");
const { favoritesDir } = require("../main/paths");
const { serveFavorites } = require("../main/protocol");

const ROOT = path.join(__dirname, "..");
const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const WIDTH = Number(arg("width", 1440));
const NICHE = arg("niche", null);
const SAVE = Number(arg("favorites", 0));
const VIEW = arg("view", null);
const HOVER = Number(arg("hover", 0));
const OUT = path.join(ROOT, arg("out", "shot.png"));
const DIR_OVERRIDE = arg("favorites-dir", null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture(win, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await win.webContents.capturePage();
    } catch (e) {
      if (i === attempts - 1) throw e;
      await sleep(700);
    }
  }
}

async function waitFor(win, expression, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await win.webContents.executeJavaScript(expression);
    if (value) return value;
    await sleep(300);
  }
  return 0;
}

app.whenReady().then(main).catch((e) => {
  console.error(`shot falhou: ${e.message}`);
  app.exit(1);
});

async function main() {
  const paths = {
    config: path.join(ROOT, "keywords.json"),
    cache: path.join(app.getPath("userData"), "pinterest-cache"),
    favorites: DIR_OVERRIDE ? path.resolve(DIR_OVERRIDE) : favoritesDir(app),
  };

  const lookbook = createLookbook({ cacheDir: paths.cache, configPath: paths.config });
  const favorites = createFavorites({ dir: paths.favorites, download: downloadToFile });
  registerLookbookIpc({ lookbook, favorites });
  serveFavorites(paths.favorites);

  const win = new BrowserWindow({
    width: WIDTH,
    height: 720,
    backgroundColor: "#FAFAF8",
    webPreferences: {
      preload: path.join(ROOT, "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await win.loadFile(path.join(ROOT, "renderer", "index.html"));

  if (process.argv.includes("--log")) {
    win.webContents.on("console-message", (event) => {
      console.log(`[console] ${event.message}`);
    });
  }

  if (NICHE) {
    await win.webContents.executeJavaScript(`
      (() => {
        const target = [...document.querySelectorAll('.chip')]
          .find((c) => c.textContent.toLowerCase().startsWith(${JSON.stringify(NICHE.toLowerCase())}));
        if (target) target.click();
        return !!target;
      })()
    `);
  }

  await waitFor(win, "document.querySelectorAll('.grid > li.is-loaded').length >= 8");
  await sleep(1200);

  if (HOVER) {
    const box = await win.webContents.executeJavaScript(`
      (() => {
        const li = document.querySelectorAll('.grid > li')[${HOVER - 1}];
        if (!li) return null;
        const r = li.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 40), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, scrollY: window.scrollY, vw: window.innerWidth, vh: window.innerHeight };
      })()
    `);
    if (box) {
      win.webContents.sendInputEvent({ type: "mouseMove", x: box.x, y: box.y });
      await sleep(500);
      const hovering = await win.webContents.executeJavaScript(`
        (() => {
          const li = document.querySelectorAll('.grid > li')[${HOVER - 1}];
          return li ? li.matches(':hover') : null;
        })()
      `);
      console.log(`hover em ${box.x},${box.y} -> li:hover=${hovering}`);
    }
  }

  if (SAVE) {
    await win.webContents.executeJavaScript(`
      (async () => {
        const buttons = [...document.querySelectorAll('.save')].slice(0, ${SAVE});
        for (const b of buttons) {
          b.click();
          await new Promise((r) => setTimeout(r, 700));
        }
        return buttons.length;
      })()
    `);
    await waitFor(win, `document.querySelectorAll('.save[aria-pressed="true"]').length >= ${SAVE}`);
    await sleep(600);
  }

  if (SAVE || VIEW === "favorites") {
    // Abre a coleção.
    const diag = await win.webContents.executeJavaScript(`
      (() => {
        const chips = [...document.querySelectorAll('.chip')];
        const target = chips.find((c) => c.textContent.startsWith('Favoritos'));
        if (target) target.click();
        return { chips: chips.map((c) => c.textContent), found: !!target };
      })()
    `);
    console.log(`chips=[${diag.chips.join(" | ")}] achouFavoritos=${diag.found}`);
    const found = await waitFor(
      win,
      "document.querySelectorAll('.grid > li.is-loaded').length >= 1",
      20000
    );
    if (!found) console.log("aviso: nenhuma imagem de favorito carregou");
    await sleep(1400);
  }

  const read = (id) =>
    win.webContents.executeJavaScript(`document.getElementById('${id}').textContent`);
  const title = await read("niche-title");
  const count = await read("count");
  const status = await read("status");
  const saved = await win.webContents.executeJavaScript(
    "document.querySelectorAll('.save[aria-pressed=\"true\"]').length"
  );
  const pressedChip = await win.webContents.executeJavaScript(
    "(document.querySelector('.chip[aria-pressed=\"true\"]') || {}).textContent || null"
  );
  const isEmpty = await win.webContents.executeJavaScript("!!document.querySelector('.empty')");

  const image = await capture(win);
  fs.writeFileSync(OUT, image.toPNG());

  console.log(
    `titulo="${title}" count="${count}" salvos=${saved} chip="${pressedChip}" vazio=${isEmpty} status="${status.trim()}"`
  );
  console.log(`print: ${OUT}`);
  app.exit(0);
}