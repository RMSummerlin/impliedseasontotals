#!/usr/bin/env node
/* ===================================================================
 * build-implied-totals.mjs  —  Sharp Football implied-totals engine
 * -------------------------------------------------------------------
 * TWO LAYERS, both real Vegas. No model, no guessing.
 *
 *   1. BASELINE  baseline-2026-dk.json — DraftKings lines for ALL 272 games,
 *      copied at schedule release. Source of truth for every week.
 *   2. LIVE      ESPN's free API — as each week's current line gets posted,
 *      it OVERRIDES the baseline for that game.
 *
 * Implied total = total/2 - team_spread/2   (team_spread positive = underdog)
 *
 * Usage:
 *   node build-implied-totals.mjs                 -> fetch ESPN, write implied-totals.json
 *   node build-implied-totals.mjs --offline       -> baseline only (no network)
 *   node build-implied-totals.mjs out.json        -> custom output path
 *
 * Node 18+. Zero dependencies. Zero cost.
 * =================================================================== */

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const OFFLINE = args.includes("--offline");
const OUT = args.find((a) => !a.startsWith("--")) || "implied-totals.json";
const BASELINE = "baseline-2026-dk.json";

const SEASON = 2026;
const REG_WEEKS = 18;
const PLAYOFF_WEEKS = [15, 16, 17];

const COLOR = {
  ARI:"#97233F", ATL:"#A71930", BAL:"#241773", BUF:"#00338D", CAR:"#0085CA",
  CHI:"#0B162A", CIN:"#FB4F14", CLE:"#311D00", DAL:"#041E42", DEN:"#FB4F14",
  DET:"#0076B6", GB:"#203731",  HOU:"#03202F", IND:"#002C5F", JAX:"#006778",
  KC:"#E31837",  LV:"#000000",  LAC:"#0080C6", LAR:"#003594", MIA:"#008E97",
  MIN:"#4F2683", NE:"#002244",  NO:"#D3BC8D",  NYG:"#0B2265", NYJ:"#125740",
  PHI:"#004C54", PIT:"#FFB612", SF:"#AA0000",  SEA:"#69BE28", TB:"#D50A0A",
  TEN:"#0C2340", WAS:"#5A1414"
};

const NORM = { WSH: "WAS", LA: "LAR" };
const norm = (a) => NORM[a] || a;
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

const SCOREBOARD = (wk) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${SEASON}&seasontype=2&week=${wk}`;

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "sharp-implied-totals/2.0" } });
      if (r.ok) return await r.json();
    } catch (_) {}
    await new Promise((res) => setTimeout(res, 400 * (i + 1)));
  }
  throw new Error("fetch failed: " + url);
}

/* ---------- 1. load the DraftKings baseline (all 272 games) ---------- */
const base = JSON.parse(readFileSync(BASELINE, "utf8"));
const NAME = base.names;

// key: week|TEAM  -> { wk, team, opp, spread, total, implied, src }
const G = new Map();
for (const g of base.games) {
  G.set(`${g.wk}|${g.team}`, { ...g, src: "open" });
}

/* ---------- 2. override with live ESPN lines where posted ---------- */
function parseESPN(ev) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const cs = comp.competitors || [];
  const home = norm(cs.find((c) => c.homeAway === "home")?.team?.abbreviation || "");
  const away = norm(cs.find((c) => c.homeAway === "away")?.team?.abbreviation || "");
  if (!home || !away) return null;

  const odds = comp.odds?.[0];
  if (!odds || typeof odds.overUnder !== "number") return null;
  const total = odds.overUnder;

  let line = null, favIsHome = null;
  if (odds.homeTeamOdds?.favorite === true) favIsHome = true;
  else if (odds.awayTeamOdds?.favorite === true) favIsHome = false;
  if (typeof odds.spread === "number") line = Math.abs(odds.spread);
  if (line == null && typeof odds.details === "string") {
    const m = odds.details.match(/(-?\d+(\.\d+)?)/);
    if (m) line = Math.abs(parseFloat(m[1]));
  }
  if (favIsHome == null && typeof odds.details === "string") {
    const m = odds.details.match(/^([A-Z]{2,4})/);
    if (m) { const f = norm(m[1]); if (f === home) favIsHome = true; else if (f === away) favIsHome = false; }
  }
  if (line == null || favIsHome == null) return null;

  // team spread: negative = favorite
  const homeSpread = favIsHome ? -line : line;
  return {
    home, away, total,
    homeSpread, awaySpread: -homeSpread
  };
}

let overrides = 0;
if (!OFFLINE) {
  for (let wk = 1; wk <= REG_WEEKS; wk++) {
    let sb;
    try { sb = await getJSON(SCOREBOARD(wk)); }
    catch (e) { console.error(`week ${wk}: ${e.message} (keeping baseline)`); continue; }
    for (const ev of sb.events || []) {
      const p = parseESPN(ev);
      if (!p) continue;
      for (const [team, opp, spread] of [
        [p.home, p.away, p.homeSpread],
        [p.away, p.home, p.awaySpread],
      ]) {
        const k = `${wk}|${team}`;
        if (!G.has(k)) continue;                       // unknown team/week -> skip
        G.set(k, {
          wk, team, opp, spread, total: p.total,
          implied: r2(p.total / 2 - spread / 2),
          src: "live",
        });
        overrides++;
      }
    }
    process.stderr.write(`week ${wk} ✓\n`);
  }
}

/* ---------- 3. aggregate ---------- */
const byTeam = {};
for (const g of G.values()) {
  (byTeam[g.team] ||= []).push(g);
}

const teams = Object.keys(byTeam).map((abbr) => {
  const gs = byTeam[abbr].slice().sort((a, b) => a.wk - b.wk);
  const live = gs.filter((g) => g.src === "live").length;
  const wk = (w) => gs.find((g) => g.wk === w);
  const pts = (w) => { const g = wk(w); return g ? r1(g.implied) : 0; };

  // full 17-game schedule, with the bye week made explicit
  const played = new Set(gs.map((g) => g.wk));
  const bye = [];
  for (let w = 1; w <= REG_WEEKS; w++) if (!played.has(w)) bye.push(w);

  const games = gs.map((g) => ({
    wk: g.wk,
    opp: g.opp,
    pts: r1(g.implied),
    src: g.src,
  }));

  const sum = gs.reduce((s, g) => s + g.implied, 0);

  return {
    abbr,
    name: NAME[abbr],
    color: COLOR[abbr],
    ppg: r1(sum / gs.length),                                   // avg over 17 games
    total: r1(sum),                                             // 17-game sum (kept for reference)
    playoff: r1(PLAYOFF_WEEKS.reduce((s, w) => s + pts(w), 0)), // wks 15-17 combined
    w15: pts(15), w16: pts(16), w17: pts(17),
    bye: bye[0] || null,
    games,
    games_live: live,
    games_open: gs.length - live,
  };
}).sort((a, b) => b.ppg - a.ppg);

const anyLive = teams.some((t) => t.games_live > 0);
const now = new Date();
const out = {
  updated: `${now.getMonth() + 1}/${now.getDate()} ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][now.getDay()]}`,
  season: SEASON,
  source: anyLive ? "mixed" : "open",
  playoff_weeks: PLAYOFF_WEEKS,
  teams,
};

writeFileSync(OUT, JSON.stringify(out));
process.stderr.write(
  `\nWrote ${OUT}\n  teams=${teams.length}  games=${G.size}  live-overrides=${overrides}  source=${out.source}\n`
);
process.stderr.write(
  `  top: ${teams[0].name} ${teams[0].ppg} ppg | playoff leader: ` +
  `${teams.slice().sort((a,b)=>b.playoff-a.playoff)[0].name}\n`
);
