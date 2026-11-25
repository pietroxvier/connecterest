"use strict";
// `npm run check`: sintaxe de todos os JS + testes offline.
// É o único comando que um agente precisa rodar antes de dizer "pronto".

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DIRS = ["main", "preload", "renderer", "scripts", "tests"];

function collectJs(dir) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];

  const out = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJs(relative));
    } else if (entry.name.endsWith(".js")) {
      out.push(relative);
    }
  }
  return out;
}

const files = DIRS.flatMap(collectJs);
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", path.join(ROOT, file)], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    failed = true;
    console.error(`sintaxe: ${file}\n${result.stderr.trim()}`);
  }
}

console.log(`sintaxe: ${files.length} arquivos ${failed ? "com erro" : "ok"}`);

const tests = spawnSync(
  process.execPath,
  ["--test", path.join(ROOT, "tests", "unit.test.js")],
  { stdio: "inherit" }
);

if (tests.status !== 0) failed = true;

process.exit(failed ? 1 : 0);