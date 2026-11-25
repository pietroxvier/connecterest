"use strict";
// Orquestra config + transporte. Não conhece Electron, então dá para testar puro.

const fs = require("node:fs");
const { parseNiches, pinterestError } = require("./lib");
const { createPinterest } = require("./pinterest");

const DEFAULT_LIMIT = 36;
const DEFAULT_PER_QUERY = 18;

function loadNiches(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    throw pinterestError("config_missing", configPath);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw pinterestError("config_invalid_json", e.message);
  }

  return parseNiches(parsed);
}

function createLookbook({ cacheDir, configPath, minIntervalMs, transport } = {}) {
  const niches = loadNiches(configPath);
  const pinterest =
    transport || createPinterest({ cacheDir, minIntervalMs });

  const byId = new Map(niches.map((niche) => [niche.id, niche]));

  return {
    niches: () => niches.map(({ id, label }) => ({ id, label })),

    async feed(nicheId, { limit = DEFAULT_LIMIT, perQuery = DEFAULT_PER_QUERY } = {}) {
      const niche = byId.get(nicheId);
      if (!niche) throw pinterestError("unknown_niche", String(nicheId));
      return pinterest.feed(niche.queries, { limit, perQuery });
    },
  };
}

module.exports = { createLookbook, loadNiches };