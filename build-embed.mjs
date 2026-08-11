#!/usr/bin/env node
/* ===================================================================
 * build-embed.mjs — generates implied-totals-WP.html
 *
 * Injects into embed.template.html:
 *   __ROWS__        real <tr> rows for all 32 teams (season table)
 *   __WEEK_ROWS__   real <tr> rows for the current week
 *   __GAME_CARDS__  real markup for the matchup cards
 *   __PINNED__      last week's leftovers, if any are still in the window
 *   __SEED__        the same data as JSON, for sorting + the breakdowns
 *   __TITLE__ / __SUB__ / __UPDATED__ / __FOOT__ / tab + pane state
 *
 * BOTH tables are pre-rendered, so the weekly view and the season view are
 * crawlable with JavaScript disabled. The inactive pane is hidden with CSS,
 * not omitted from the markup.
 *
 * The SSR markup and the SEED are produced from the SAME source object, so
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
const sgn = (n) => (n > 0 ? "+" : "") + fmt(n);
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const inSeason = !!(data.week && data.week.games && data.week.games.length);
const WK = inSeason ? data.week.number : null;

const moveCls = (m) => (m == null ? "flat" : m > 0 ? "up" : m < 0 ? "dn" : "flat");
const moveTxt = (m) => (m == null ? "—" : m === 0 ? "0.0" : sgn(m));
const spreadTxt = (g) => {
  if (g.spread == null) return "—";
  if (g.spread === 0) return "PK";
  return g.spread < 0 ? `${g.home.abbr} ${fmt(g.spread)}` : `${g.away.abbr} ${fmt(-g.spread)}`;
};

/* ---------------- season table ----------------
   The headline column is the rest-of-season average once games have been
   played AND games remain. Before week 1, and after the last game is final,
   it is the full 17-game average — labelled so the two are never confused. */
const anyPlayed = data.teams.some((t) => t.games_left != null && t.games_left < 17);
const anyLeft = data.teams.some((t) => t.ppg_rest != null && t.games_left > 0);
const seasonKey = anyPlayed && anyLeft ? "ppg_rest" : "ppg";
const seasonLabel =
  seasonKey === "ppg_rest" ? "Rest of Season" : anyPlayed ? "Season Avg" : "Pts / Game";
const seasonVal = (t) => {
  const v = t[seasonKey];
  return v == null ? t.ppg : v;
};

const rows = data.teams.slice().sort((a, b) => seasonVal(b) - seasonVal(a));

const rowHTML = (t, i) =>
  `        <tr class="tr-team" data-abbr="${t.abbr}">` +
  `<td class="tm"><button class="pt-teambtn" type="button" aria-expanded="false">` +
  `<span class="pt-rank">${i + 1}</span>` +
  `<span class="pt-chip" style="background:${t.color}"></span>` +
  `<span class="pt-name">${esc(t.name)}</span>` +
  `<span class="pt-caret">&#9654;</span>` +
  `</button></td>` +
  `<td class="big">${fmt(seasonVal(t))}</td>` +
  `<td class="po">${fmt(t.playoff)}</td>` +
  `<td>${fmt(t.w15)}</td>` +
  `<td>${fmt(t.w16)}</td>` +
  `<td>${fmt(t.w17)}</td>` +
  `</tr>`;

const ssr = rows.map(rowHTML).join("\n");

/* ---------------- week table ----------------
   Same ordering rule as the client: implied desc, rows still waiting on a
   real line parked below, byes last. */
function weekRows() {
  if (!inSeason) return [];
  const out = [];
  for (const g of data.week.games) {
    for (const s of [g.away, g.home]) {
      out.push({
        abbr: s.abbr, name: s.name, color: s.color, opp: s.opp,
        implied: s.implied, open: s.open, move: s.move,
        awaiting: s.awaiting, home: s === g.home,
      });
    }
  }
  const playing = new Set(out.map((r) => r.abbr));
  for (const t of data.teams) {
    if (!playing.has(t.abbr)) {
      out.push({ abbr: t.abbr, name: t.name, color: t.color, opp: "BYE", bye: true,
        implied: null, open: null, move: null });
    }
  }
  out.sort((a, b) => {
    if (!!a.bye !== !!b.bye) return a.bye ? 1 : -1;
    if (!a.bye && !!a.awaiting !== !!b.awaiting) return a.awaiting ? 1 : -1;
    const av = a.implied, bv = b.implied;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });
  return out;
}

const weekRowHTML = (r, i) =>
  `        <tr class="tr-team${r.bye ? " byerow" : r.awaiting ? " await" : ""}" data-abbr="${r.abbr}">` +
  `<td class="tm"><button class="pt-teambtn" type="button" aria-expanded="false">` +
  `<span class="pt-rank">${r.bye || r.awaiting ? "&middot;" : i + 1}</span>` +
  `<span class="pt-chip" style="background:${r.color}"></span>` +
  `<span class="pt-name">${esc(r.name)}</span>` +
  `<span class="pt-caret">&#9654;</span>` +
  `</button></td>` +
  `<td class="opp">${r.bye ? "BYE" : (r.home ? "vs " : "@ ") + esc(r.opp)}</td>` +
  `<td class="big">${r.implied != null ? fmt(r.implied) : "—"}` +
  `${r.awaiting && !r.bye ? '<span class="pt-flag">OPEN</span>' : ""}</td>` +
  `<td>${r.open != null ? fmt(r.open) : "—"}</td>` +
  `<td><span class="pt-mv ${moveCls(r.bye ? null : r.move)}">${r.bye ? "—" : moveTxt(r.move)}</span></td>` +
  `</tr>`;

const wssr = weekRows().map(weekRowHTML).join("\n");

/* ---------------- matchup cards ---------------- */
function cardsHTML() {
  if (!inSeason) return "";
  const out = [];
  let lastSlot = null;
  for (const g of data.week.games) {
    const label = `${g.day} · ${g.slot}`;
    if (label !== lastSlot) {
      out.push(`        <div class="pt-slot">${esc(label)}</div>`);
      lastSlot = label;
    }
    const sides = [g.away, g.home]
      .map(
        (s) =>
          `<div class="pt-side">` +
          `<span class="pt-chip" style="background:${s.color}"></span>` +
          `<span class="nm">${esc(s.name)}</span>` +
          `<span class="mv pt-mv ${moveCls(s.move)}">${s.move != null && s.move !== 0 ? moveTxt(s.move) : ""}</span>` +
          `<span class="val">${s.implied != null ? fmt(s.implied) : "—"}</span>` +
          `</div>`
      )
      .join("");
    out.push(
      `        <div class="pt-card">${sides}` +
        `<div class="pt-cfoot">` +
        `<div>Total <b>${g.total != null ? fmt(g.total) : "—"}</b></div>` +
        `<div>Spread <b>${esc(spreadTxt(g))}</b></div>` +
        (g.awaiting ? `<div>Awaiting this week&rsquo;s line</div>` : "") +
        `</div></div>`
    );
  }
  return out.join("\n");
}

/* ---------------- pinned band ---------------- */
function pinnedHTML() {
  const p = data.pinned;
  if (!p || !p.games || !p.games.length) return "";
  const games = p.games
    .map((g) => {
      const final = g.completed || g.state === "post";
      const rows = [g.away, g.home]
        .map(
          (s) =>
            `<div class="pt-pin-row">` +
            `<span class="pt-chip" style="background:${s.color}"></span>` +
            `<span class="nm">${esc(s.name)}</span>` +
            (final && s.score != null ? `<span class="sc">${s.score}</span>` : "") +
            `<span class="val">${s.implied != null ? fmt(s.implied) : "—"}</span>` +
            `</div>`
        )
        .join("");
      return (
        `<div class="pt-pin-g">${rows}` +
        `<div class="pt-pin-ft">${esc(g.day)} &middot; ${esc(g.slot)}` +
        (final ? " &middot; Final" : g.state === "in" ? " &middot; In progress" : "") +
        (g.total != null ? ` &middot; Total ${fmt(g.total)}` : "") +
        `</div></div>`
      );
    })
    .join("");
  return (
    `<div class="pt-pin">` +
    `<div class="pt-pin-hd">Still from week ${esc(p.number)}` +
    `<span class="sub">The table below has already moved on to week ${esc(WK)}</span></div>` +
    games +
    `</div>`
  );
}

/* ---------------- header copy + pane state ---------------- */
const TITLE = "NFL Implied Team Totals";
const SUB = inSeason
  ? `Projected points for every team in week ${WK} — straight from the sportsbook lines, ` +
    `with the week&rsquo;s opening number and the move since.`
  : `Projected points for every team, every game — straight from the sportsbook lines. ` +
    `Tap a team for its full 17-game slate.`;
const FOOT = inSeason
  ? `Implied total = game total &divide; 2 &minus; team spread &divide; 2. ` +
    `Opening number is the line when week ${WK} went up.`
  : `Implied total = game total &divide; 2 &minus; team spread &divide; 2.`;

const defaultTab = inSeason ? "week" : "season";

/* Trim the seed to only what the client needs (keeps the paste small). */
const trimSide = (s) => ({
  abbr: s.abbr, name: s.name, color: s.color, opp: s.opp,
  implied: s.implied, open: s.open, move: s.move,
  awaiting: s.awaiting, score: s.score,
});
const trimGame = (g) => ({
  day: g.day, slot: g.slot, state: g.state, completed: g.completed,
  total: g.total, total_open: g.total_open, spread: g.spread,
  awaiting: g.awaiting, home: trimSide(g.home), away: trimSide(g.away),
});

const seed = {
  updated: data.updated,
  season: data.season,
  source: data.source,
  phase: data.phase,
  display_week: data.display_week,
  week: inSeason ? { number: WK, games: data.week.games.map(trimGame) } : null,
  pinned: data.pinned ? { number: data.pinned.number, games: data.pinned.games.map(trimGame) } : null,
  teams: data.teams.map((t) => ({
    abbr: t.abbr, name: t.name, color: t.color,
    ppg: t.ppg, ppg_rest: t.ppg_rest, games_left: t.games_left,
    playoff: t.playoff,
    w15: t.w15, w16: t.w16, w17: t.w17,
    // no `src` here: the season bars do not show provenance, and 544 copies
    // of it is ~8KB of paste. The week view uses its own `awaiting` flag.
    // `played`/`score` only appear once a game is final, so they cost nothing
    // until they carry information.
    games: t.games.map((g) => {
      const o = { wk: g.wk, opp: g.opp, pts: g.pts };
      if (g.played) { o.played = 1; o.score = g.score; o.opp_score = g.opp_score; }
      return o;
    }),
  })),
};

const subs = {
  __TITLE__: TITLE,
  __SUB__: SUB,
  __FOOT__: FOOT,
  __UPDATED__: esc(data.updated),
  __DATA_URL__: DATA_URL,
  __ROWS__: ssr,
  __WEEK_ROWS__: wssr,
  __GAME_CARDS__: cardsHTML(),
  __PINNED__: pinnedHTML(),
  __PINNED_GAMES__: pinnedHTML(),
  __SEED__: JSON.stringify(seed),
  __WEEK_TAB_LABEL__: inSeason ? `Week ${WK}` : "This Week",
  __SEASON_KEY__: seasonKey,
  __SEASON_LABEL__: seasonLabel,
  __DEFAULT_TAB__: defaultTab,
  __TABS_OFF__: inSeason ? "" : " is-off",
  __ON_WEEK__: defaultTab === "week" ? " is-on" : "",
  __ON_GAMES__: "",
  __ON_SEASON__: defaultTab === "season" ? " is-on" : "",
  __PANE_WEEK_OFF__: defaultTab === "week" ? "" : " is-off",
  __PANE_GAMES_OFF__: " is-off",
  __PANE_SEASON_OFF__: defaultTab === "season" ? "" : " is-off",
};

let html = readFileSync(TPL, "utf8");
for (const [k, v] of Object.entries(subs)) {
  html = html.split(k).join(v);
}
for (const ph of Object.keys(subs)) {
  if (html.includes(ph)) throw new Error(`template placeholder not substituted: ${ph}`);
}

// --page wraps the fragment in a standalone document (used for the Pages preview)
if (PAGE) {
  const title = inSeason
    ? `NFL Week ${WK} Implied Team Totals`
    : `2026 NFL Implied Team Totals`;
  const desc = inSeason
    ? `Implied team totals for every NFL game in week ${WK}, from sportsbook lines — ` +
      `opening number, current number and the movement between them.`
    : `Projected points for all 32 NFL teams for every game of the 2026 season, from sportsbook lines. ` +
      `Season totals plus fantasy playoff weeks 15-17.`;
  html =
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${title}</title>\n` +
    `<meta name="description" content="${desc}">\n` +
    `<style>body{margin:0;padding:16px;background:#e9ecf0;font-family:system-ui,sans-serif}` +
    `.wrap{max-width:760px;margin:0 auto}</style>\n</head>\n<body>\n<div class="wrap">\n` +
    html +
    `\n</div>\n</body>\n</html>\n`;
}

writeFileSync(OUT, html);

console.log(`Wrote ${OUT}${PAGE ? " (standalone page)" : ""}`);
console.log(`  phase: ${data.phase}${inSeason ? ` — week ${WK}, default tab: ${defaultTab}` : ""}`);
console.log(`  pre-rendered season rows: ${rows.length}`);
console.log(`  pre-rendered week rows:   ${inSeason ? weekRows().length : 0}`);
console.log(`  pinned games:             ${data.pinned ? data.pinned.games.length : 0}`);
console.log(`  DATA_URL: ${DATA_URL || "(none — pre-rendered lines only)"}`);
console.log(`  size: ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
console.log(`  top: ${rows[0].name} ${fmt(rows[0].ppg)} ppg`);
