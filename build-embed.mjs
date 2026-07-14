#!/usr/bin/env node
/* ===================================================================
 * build-embed.mjs — generates implied-totals-WP.html
 *
 * Injects into embed.template.html:
 *   __ROWS__    real <tr> rows for all 32 teams, so the table is in the
 *               base HTML and crawlable with JavaScript disabled
 *   __SEED__    the same data as JSON, for sorting + the team breakdown
 *   __UPDATED__ the feed's date stamp
 *
 * The SSR rows and the SEED are produced from the SAME source object, so
 * they can never disagree.
 *
 *   node build-embed.mjs                                  # -> implied-totals-WP.html
 *   node build-embed.mjs feed.json out.html
 *   DATA_URL=https://... node build-embed.mjs             # wire the live feed in
 *   node build-embed.mjs feed.json index.html --page      # full standalone page
 * =================================================================== */

import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const PAGE = process.argv.includes("--page");
const FEED = argv[0] || "implied-totals.json";
const OUT = argv[1] || "implied-totals-WP.html";
const TPL = "embed.template.html";
const DATA_URL = process.env.DATA_URL || "";

const data = JSON.parse(readFileSync(FEED, "utf8"));

const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1);
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// default view = sorted by points per game, descending (matches the script's initial state)
const rows = data.teams.slice().sort((a, b) => b.ppg - a.ppg);

const rowHTML = (t, i) =>
  `        <tr class="tr-team" data-abbr="${t.abbr}">` +
  `<td class="tm"><button class="pt-teambtn" type="button" aria-expanded="false">` +
  `<span class="pt-rank">${i + 1}</span>` +
  `<span class="pt-chip" style="background:${t.color}"></span>` +
  `<span class="pt-name">${esc(t.name)}</span>` +
  `<span class="pt-caret">&#9654;</span>` +
  `</button></td>` +
  `<td class="big">${fmt(t.ppg)}</td>` +
  `<td class="po">${fmt(t.playoff)}</td>` +
  `<td>${fmt(t.w15)}</td>` +
  `<td>${fmt(t.w16)}</td>` +
  `<td>${fmt(t.w17)}</td>` +
  `</tr>`;

const ssr = rows.map(rowHTML).join("\n");

// Trim the seed to only what the client needs (keeps the paste small).
const seed = {
  updated: data.updated,
  season: data.season,
  source: data.source,
  teams: data.teams.map((t) => ({
    abbr: t.abbr, name: t.name, color: t.color,
    ppg: t.ppg, playoff: t.playoff,
    w15: t.w15, w16: t.w16, w17: t.w17,
    games: t.games.map((g) => ({ wk: g.wk, opp: g.opp, pts: g.pts })),
  })),
};

let html = readFileSync(TPL, "utf8");
html = html
  .replace("__UPDATED__", esc(data.updated))
  .replace("__DATA_URL__", DATA_URL)
  .replace("__ROWS__", ssr)
  .replace("__SEED__", JSON.stringify(seed));

for (const ph of ["__ROWS__", "__SEED__", "__UPDATED__", "__DATA_URL__"]) {
  if (html.includes(ph)) throw new Error(`template placeholder not substituted: ${ph}`);
}

// --page wraps the fragment in a standalone document (used for the Pages preview)
if (PAGE) {
  html =
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>2026 NFL Implied Team Totals</title>\n` +
    `<meta name="description" content="Projected points for all 32 NFL teams for every game of the 2026 season, from sportsbook lines. Season totals plus fantasy playoff weeks 15-17.">\n` +
    `<style>body{margin:0;padding:16px;background:#e9ecf0;font-family:system-ui,sans-serif}` +
    `.wrap{max-width:760px;margin:0 auto}</style>\n</head>\n<body>\n<div class="wrap">\n` +
    html +
    `\n</div>\n</body>\n</html>\n`;
}

writeFileSync(OUT, html);

console.log(`Wrote ${OUT}${PAGE ? " (standalone page)" : ""}`);
console.log(`  pre-rendered rows: ${rows.length}`);
console.log(`  DATA_URL: ${DATA_URL || "(none — pre-rendered lines only)"}`);
console.log(`  size: ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
console.log(`  top: ${rows[0].name} ${fmt(rows[0].ppg)} ppg`);
