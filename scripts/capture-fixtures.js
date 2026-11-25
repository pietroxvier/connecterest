"use strict";
// Gera tests/fixtures/*.json com respostas reais do Pinterest.
// Rode só quando quiser atualizar as fixtures: node scripts/capture-fixtures.js
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function get(query, pageSize = 24) {
  return new Promise((resolve, reject) => {
    const options = { query, scope: "pins", page_size: pageSize };
    const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}`;
    const url =
      "https://www.pinterest.com/resource/BaseSearchResource/get/" +
      `?source_url=${encodeURIComponent(sourceUrl)}` +
      `&data=${encodeURIComponent(JSON.stringify({ options, context: {} }))}`;

    https
      .get(
        url,
        {
          headers: {
            "User-Agent": UA,
            Accept: "application/json, text/javascript, */*, q=0.01",
            "X-Pinterest-PWS-Handler": "www/index.js",
            "X-Requested-With": "XMLHttpRequest",
            Referer: `https://www.pinterest.com${sourceUrl}`,
          },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        }
      )
      .on("error", reject);
  });
}

async function main() {
  const outDir = path.join(__dirname, "..", "tests", "fixtures");

  const cases = [
    { file: "search-ok.json", query: "gothic outfit", note: "busca normal, com pins" },
    { file: "search-empty.json", query: "coquette aesthetic", note: "0 pins + objeto sensitivity" },
  ];

  for (const c of cases) {
    const { status, body } = await get(c.query);
    const parsed = JSON.parse(body);
    const count = parsed?.resource_response?.data?.results?.length ?? -1;
    fs.writeFileSync(path.join(outDir, c.file), body, "utf8");
    console.log(`${c.file}  http=${status}  pins=${count}  (${c.note})`);
    await new Promise((r) => setTimeout(r, 1200));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});