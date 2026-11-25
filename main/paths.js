"use strict";
// Caminhos que dependem do sistema do usuário.
// getPath("pictures") falha em algumas máquinas (pasta não registrada,
// redirecionamento do OneDrive), então há uma cadeia de fallback.

const os = require("node:os");
const path = require("node:path");

function favoritesDir(app) {
  const candidates = ["pictures", "documents"];

  for (const key of candidates) {
    try {
      return path.join(app.getPath(key), "Lookbook");
    } catch {
      /* tenta o próximo */
    }
  }

  try {
    return path.join(os.homedir(), "Lookbook");
  } catch {
    return path.join(process.cwd(), "Lookbook");
  }
}

module.exports = { favoritesDir };