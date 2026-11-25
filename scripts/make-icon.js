"use strict";
// Gera assets/icon.png (1024) e assets/icon.ico (256/48/32/16).
// O SVG é rasterizado num canvas, não no viewport: a janela pode ser menor
// que a tela e o resultado continua 1024x1024.
// Uso: npx electron scripts/make-icon.js
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, nativeImage } = require("electron");

const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const SIZES = [256, 48, 32, 16];

function packIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + 16 * entries.length;
  const dirs = entries.map((entry) => {
    const dir = Buffer.alloc(16);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, 0);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, 1);
    dir.writeUInt8(0, 2);
    dir.writeUInt8(0, 3);
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(entry.png.length, 8);
    dir.writeUInt32LE(offset, 12);
    offset += entry.png.length;
    return dir;
  });

  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    webPreferences: { offscreen: false },
  });

  await win.loadURL("about:blank");

  // SVG embutido como data URL: sem depender de acesso a file://.
  const svg = fs.readFileSync(path.join(ASSETS, "icon.svg"), "utf8");
  const svgUrl = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  const dataUrl = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 1024;
        canvas.height = 1024;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, 1024, 1024);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => reject(new Error("falha ao carregar o svg"));
      img.src = ${JSON.stringify(svgUrl)};
    })
  `);

  const base = nativeImage.createFromDataURL(dataUrl);
  fs.writeFileSync(path.join(ASSETS, "icon.png"), base.toPNG());
  console.log(`icon.png ${base.getSize().width}x${base.getSize().height}`);

  const entries = SIZES.map((size) => ({
    size,
    png: base.resize({ width: size, height: size, quality: "best" }).toPNG(),
  }));

  fs.writeFileSync(path.join(ASSETS, "icon.ico"), packIco(entries));
  console.log(`icon.ico ${SIZES.join("/")} (${fs.statSync(path.join(ASSETS, "icon.ico")).size} bytes)`);

  app.exit(0);
});