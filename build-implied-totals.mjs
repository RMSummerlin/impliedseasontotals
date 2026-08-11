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
 * -------------------------------------------------------------------
 * IN-SEASON BEHAVIOUR
 *
 * The feed carries a WEEK block alongside the season block.
 *
 *   display_week   the week the tool shows. Flips at MONDAY 00:00 ET —
 *                  i.e. overnight Sunday, so it is fresh on Monday morning,
 *                  by which point the book has posted the new week.
 *   pinned         the previous week's leftovers (Monday night, or anything
 *                  not yet final). Sits above the new week, clearly labelled.
 *                  Carries the final score, then drops at TUESDAY 05:00 ET.
 *
 * The week boundary is derived from real kickoff timestamps, NOT from ESPN's
 * `week.number` (which rolls over late) and NOT from a hardcoded calendar.
 * Rule: displayStart(W) = Monday 00:00 ET on or before W's earliest kickoff.
 * That handles flexes, Thanksgiving, the Saturday games in weeks 15-18, and
 * the Wednesday Week 1 opener without any special-casing.
 *
 * -------------------------------------------------------------------
 * WEEK OPENERS
 *
 * ESPN publishes lookahead numbers for all 272 games months ahead, so
 * "first live line we ever saw" is NOT the week's opener. Instead the opener
 * is frozen the first time a game is part of the DISPLAY week and has a real
 * line — that is, at the Monday flip, or the first run afterwards where a
 * live line exists. Frozen values live in week-openers.json and never change.
 *
 * Usage:
 *   node build-implied-totals.mjs                 -> fetch ESPN, write implied-totals.json
 *   node build-implied-totals.mjs --offline       -> baseline + cached kickoffs (no network)
 *   node build-implied-totals.mjs out.json        -> custom output path
 *   node build-implied-totals.mjs --now=2026-10-13T09:00Z   -> pretend it is that instant
 *   node build-implied-totals.mjs --dry           -> do not write the opener ledger
 *
 * Node 18+. Zero dependencies. Zero cost.
 * =================================================================== */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const OFFLINE = args.includes("--offline");
const DRY = args.includes("--dry");
const OUT = args.find((a) => !a.startsWith("--")) || "implied-totals.json";
const BASELINE = "baseline-2026-dk.json";
const LEDGER = "week-openers.json";

const nowArg = args.find((a) => a.startsWith("--now="));
const NOW = nowArg ? Date.parse(nowArg.slice(6)) : Date.now();
if (Number.isNaN(NOW)) throw new Error("bad --now= value");

/* dev only: read week JSON from DIR/w<N>.json instead of hitting ESPN */
const cacheArg = args.find((a) => a.startsWith("--cache="));
const CACHE = cacheArg ? cacheArg.slice(8) : null;

const SEASON = 2026;
const REG_WEEKS = 18;
const PLAYOFF_WEEKS = [15, 16, 17];

/* how long the previous week's leftovers stay pinned, measured from the
   Monday 00:00 ET flip. 29h = Tuesday 05:00 ET. */
const PIN_HOURS = 29;

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

const SCOREBOARD = (wk) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${SEASON}&seasontype=2&week=${wk}`;

async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "sharp-implied-totals/3.0" } });
      if (r.ok) return await r.json();
    } catch (_) {}
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));   // 1s, 2s, 3s
  }
  throw new Error("fetch failed: " + url);
}

/* ===================================================================
 * Eastern-time helpers. Zero dependencies — Intl carries the DST rules,
 * so nothing here breaks in November.
 * =================================================================== */
const ET = "America/New_York";
const etFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: ET, hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const etSlotFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: ET, weekday: "short", hour: "numeric", minute: "2-digit",
});
const etDayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: ET, weekday: "short", month: "numeric", day: "numeric",
});

function etParts(ms) {
  const p = {};
  for (const x of etFmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return {
    y: +p.year, mo: +p.month, d: +p.day,
    h: p.hour === "24" ? 0 : +p.hour, mi: +p.minute, s: +p.second,
  };
}
/* offset of ET from UTC at a given instant, in ms (negative: ET is behind) */
function etOffset(ms) {
  const p = etParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - ms;
}
/* an ET wall-clock time -> UTC instant */
function fromET(y, mo, d, h, mi) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - etOffset(guess);
  return guess;
}
/* Monday 00:00 ET on or before the given instant */
function mondayBeforeET(ms) {
  const p = etParts(ms);
  const dow = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay(); // 0 Sun .. 6 Sat
  const back = (dow + 6) % 7;                                     // days since Monday
  const midnight = fromET(p.y, p.mo, p.d, 0, 0);
  return midnight - back * 86400000;
}
const slotLabel = (ms) => etSlotFmt.format(new Date(ms));          // "Sun 1:00 PM"
const dayLabel  = (ms) => etDayFmt.format(new Date(ms));           // "Mon 10/12"

/* ---------- 1. load the DraftKings baseline (all 272 games) ---------- */
const base = JSON.parse(readFileSync(BASELINE, "utf8"));
const NAME = base.names;

// key: week|TEAM  -> { wk, team, opp, spread, total, implied, src }
//
// IMPORTANT: implied is rounded to 1 decimal HERE, once, and that rounded value
// is canonical. Every downstream number (ppg, playoff, weekly) is derived from
// it, so the displayed PPG is exactly the average of the displayed weekly
// numbers. Deriving ppg from unrounded values instead lets the two disagree.
const G = new Map();
for (const g of base.games) {
  G.set(`${g.wk}|${g.team}`, { ...g, implied: r1(g.implied), src: "open" });
}

/* ---------- 1b. load the opener ledger (frozen week openers + kickoffs) ---------- */
let ledger = { season: SEASON, note: "", kickoffs: {}, openers: {} };
if (existsSync(LEDGER)) {
  try {
    const l = JSON.parse(readFileSync(LEDGER, "utf8"));
    ledger = {
      season: l.season || SEASON,
      note: l.note || "",
      kickoffs: l.kickoffs || {},
      openers: l.openers || {},
    };
  } catch (e) {
    process.stderr.write(`WARNING: ${LEDGER} unreadable (${e.message}) — starting a new ledger\n`);
  }
}

/* ---------- 2. override with live ESPN lines where posted ---------- */
function parseESPN(ev) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const cs = comp.competitors || [];
  const homeC = cs.find((c) => c.homeAway === "home");
  const awayC = cs.find((c) => c.homeAway === "away");
  const home = norm(homeC?.team?.abbreviation || "");
  const away = norm(awayC?.team?.abbreviation || "");
  if (!home || !away) return null;

  const kickoff = Date.parse(ev.date);
  const st = comp.status?.type || {};
  const meta = {
    home, away,
    kickoff: Number.isNaN(kickoff) ? null : kickoff,
    state: st.state || "pre",                    // pre | in | post
    completed: st.completed === true,
    detail: st.shortDetail || "",
    homeScore: homeC?.score != null && homeC.score !== "" ? +homeC.score : null,
    awayScore: awayC?.score != null && awayC.score !== "" ? +awayC.score : null,
    neutral: comp.neutralSite === true,
  };

  const odds = comp.odds?.[0];
  if (!odds || typeof odds.overUnder !== "number") return { ...meta, line: null };
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
  if (line == null || favIsHome == null) return { ...meta, line: null };

  // team spread: negative = favorite
  const homeSpread = favIsHome ? -line : line;
  return { ...meta, line: { total, homeSpread, awaySpread: -homeSpread } };
}

/* wk -> [ meta ] for every scheduled game we know about */
const SCHED = new Map();
/* key: week|TEAM -> { score, opp_score } for games that are final */
const RESULT = new Map();
let overrides = 0;
const missedWeeks = [];

if (!OFFLINE) {
  for (let wk = 1; wk <= REG_WEEKS; wk++) {
    let sb;
    try {
      if (CACHE) {
        sb = JSON.parse(readFileSync(`${CACHE}/w${wk}.json`, "utf8"));
      } else {
        // ESPN rate-limits bursts; pacing keeps all 18 weeks landing
        if (wk > 1) await new Promise((r) => setTimeout(r, 700));
        sb = await getJSON(SCOREBOARD(wk));
      }
    }
    catch (e) {
      console.error(`week ${wk}: ${e.message} (keeping baseline)`);
      missedWeeks.push(wk);
      continue;
    }
    const list = [];
    for (const ev of sb.events || []) {
      const p = parseESPN(ev);
      if (!p) continue;
      list.push({ ...p, wk });

      // remember kickoffs so week boundaries survive an ESPN outage
      if (p.kickoff) {
        ledger.kickoffs[`${wk}|${p.home}`] = new Date(p.kickoff).toISOString();
        ledger.kickoffs[`${wk}|${p.away}`] = new Date(p.kickoff).toISOString();
      }

      // a final score turns a projection into a result
      if (p.completed && p.homeScore != null && p.awayScore != null) {
        RESULT.set(`${wk}|${p.home}`, { score: p.homeScore, opp_score: p.awayScore });
        RESULT.set(`${wk}|${p.away}`, { score: p.awayScore, opp_score: p.homeScore });
      }

      if (!p.line) continue;
      for (const [team, opp, spread] of [
        [p.home, p.away, p.line.homeSpread],
        [p.away, p.home, p.line.awaySpread],
      ]) {
        const k = `${wk}|${team}`;
        if (!G.has(k)) continue;                       // unknown team/week -> skip
        G.set(k, {
          wk, team, opp, spread, total: p.line.total,
          implied: r1(p.line.total / 2 - spread / 2),   // 1dp is canonical — see note above
          src: "live",
        });
        overrides++;
      }
    }
    SCHED.set(wk, list);
    process.stderr.write(`week ${wk} ✓\n`);
  }
}

/* ---------- 3. week boundaries, from real kickoff times ---------- */
/* earliest kickoff per week: live data first, cached ledger as the fallback */
const earliest = new Map();
for (const [wk, list] of SCHED) {
  for (const g of list) {
    if (!g.kickoff) continue;
    if (!earliest.has(wk) || g.kickoff < earliest.get(wk)) earliest.set(wk, g.kickoff);
  }
}
for (const [key, iso] of Object.entries(ledger.kickoffs)) {
  const wk = +key.split("|")[0];
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) continue;
  if (!earliest.has(wk) || ms < earliest.get(wk)) earliest.set(wk, ms);
}

/* displayStart(W) = Monday 00:00 ET on or before W's earliest kickoff */
const startOf = new Map();
for (const [wk, ms] of earliest) startOf.set(wk, mondayBeforeET(ms));

let displayWeek = null;
for (let w = 1; w <= REG_WEEKS; w++) {
  const s = startOf.get(w);
  if (s != null && s <= NOW) displayWeek = w;
}
/* after week 18's slate is done there is no week 19 — fall back to the season view */
const lastStart = startOf.get(REG_WEEKS);
const seasonOver = lastStart != null && NOW >= lastStart + 8 * 86400000 + PIN_HOURS * 3600000;
if (seasonOver) displayWeek = null;

const phase = displayWeek == null ? (seasonOver ? "offseason" : "preseason") : "in_season";

/* ---------- 4. freeze week openers ---------- */
/* A game's opener is the line at the moment its week became the display week
   (or the first run after that where a real line exists). Never overwritten. */
let frozen = 0;
if (displayWeek != null) {
  for (const [key, g] of G) {
    if (g.wk !== displayWeek) continue;
    if (g.src !== "live") continue;              // still on the DK baseline — wait for a real line
    if (ledger.openers[key]) continue;           // already frozen
    ledger.openers[key] = {
      implied: g.implied, total: g.total, spread: g.spread,
      at: new Date(NOW).toISOString(),
    };
    frozen++;
  }
}

/* ---------- 5. build the week + pinned blocks ---------- */
function teamSide(wk, abbr, oppAbbr, score) {
  const g = G.get(`${wk}|${abbr}`);
  const open = ledger.openers[`${wk}|${abbr}`];
  const awaiting = !g || g.src !== "live";
  return {
    abbr,
    name: NAME[abbr] || abbr,
    color: COLOR[abbr] || "#7f8c9a",
    opp: oppAbbr,
    implied: g ? g.implied : null,
    open: open ? open.implied : null,
    move: g && open ? r1(g.implied - open.implied) : null,
    src: g ? g.src : "open",
    awaiting,
    score: score == null ? null : score,
  };
}

function gameBlock(meta) {
  const wk = meta.wk;
  const home = teamSide(wk, meta.home, meta.away, meta.homeScore);
  const away = teamSide(wk, meta.away, meta.home, meta.awayScore);
  const g = G.get(`${wk}|${meta.home}`);
  const openH = ledger.openers[`${wk}|${meta.home}`];
  return {
    wk,
    kickoff: meta.kickoff ? new Date(meta.kickoff).toISOString() : null,
    slot: meta.kickoff ? slotLabel(meta.kickoff) : "TBD",
    day: meta.kickoff ? dayLabel(meta.kickoff) : "TBD",
    state: meta.state,
    completed: meta.completed,
    detail: meta.detail,
    neutral: meta.neutral,
    total: g ? g.total : null,
    total_open: openH ? openH.total : null,
    spread: g ? g.spread : null,          // home spread, negative = home favoured
    spread_open: openH ? openH.spread : null,
    awaiting: home.awaiting || away.awaiting,
    home, away,
  };
}

const bySlot = (a, b) => String(a.kickoff || "").localeCompare(String(b.kickoff || ""));

let weekBlock = null, pinnedBlock = null;
if (displayWeek != null) {
  const start = startOf.get(displayWeek);
  const list = (SCHED.get(displayWeek) || []).slice();
  /* If the display week's fetch failed, publishing would blank the weekly
     view. Better to fail the run and leave the last good feed in place —
     the next run is only three hours away, and the flip is time-based so it
     catches up on its own. */
  if (!list.length && !OFFLINE) {
    throw new Error(
      `could not load week ${displayWeek} from ESPN (missed weeks: ${missedWeeks.join(", ") || "none"}) — ` +
      `refusing to publish an empty week`
    );
  }

  weekBlock = {
    number: displayWeek,
    start: start != null ? new Date(start).toISOString() : null,
    games: list.map(gameBlock).sort(bySlot),
  };

  /* leftovers from the previous week: anything kicking off on/after this
     week's Monday flip, plus anything that somehow is not final yet. */
  const prev = displayWeek - 1;
  if (prev >= 1 && start != null && NOW < start + PIN_HOURS * 3600000) {
    const prevGames = SCHED.get(prev) || [];
    /* Monday-or-later kickoffs are the normal case. A game that kicked off
       earlier and still is not final (in progress, postponed) rides along. */
    const late = prevGames.filter((g) => g.kickoff != null && g.kickoff >= start);
    const stuck = prevGames.filter(
      (g) => g.kickoff != null && g.kickoff < start && !g.completed && g.kickoff <= NOW
    );
    /* If ESPN's status flags go stale, `stuck` can balloon to the whole slate.
       Past a handful, stop trusting the flags and keep only the schedule. */
    const left = stuck.length > 4 ? late : late.concat(stuck);
    if (left.length) {
      pinnedBlock = { number: prev, games: left.map(gameBlock).sort(bySlot) };
    }
  }
}

/* ---------- 6. aggregate the season block (unchanged shape) ---------- */
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

  const games = gs.map((g) => {
    const res = RESULT.get(`${g.wk}|${abbr}`);
    const row = {
      wk: g.wk,
      opp: g.opp,
      pts: r1(g.implied),
      src: g.src,
    };
    /* a game only leaves the rest-of-season average once it is FINAL */
    if (res) {
      row.played = true;
      row.score = res.score;
      row.opp_score = res.opp_score;
    }
    return row;
  });

  const sum = gs.reduce((s, g) => s + g.implied, 0);

  /* rest of season: the implied totals for games that have not happened yet.
     Before week 1 this is identical to the full-season average; after the
     last game it is null and the UI falls back to the full-season number. */
  const left = games.filter((g) => !g.played);
  const leftSum = left.reduce((s, g) => s + g.pts, 0);

  return {
    abbr,
    name: NAME[abbr],
    color: COLOR[abbr],
    ppg: r1(sum / gs.length),                                   // avg over all 17 games
    ppg_rest: left.length ? r1(leftSum / left.length) : null,   // avg over games still to play
    games_left: left.length,
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
const now = new Date(NOW);
const out = {
  updated: `${now.getMonth() + 1}/${now.getDate()} ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][now.getDay()]}`,
  season: SEASON,
  source: anyLive ? "mixed" : "open",
  phase,                      // preseason | in_season | offseason
  display_week: displayWeek,  // null outside the regular season
  week: weekBlock,            // null outside the regular season
  pinned: pinnedBlock,        // null unless last week has leftovers in the window
  playoff_weeks: PLAYOFF_WEEKS,
  teams,
};

writeFileSync(OUT, JSON.stringify(out));

if (!DRY) {
  ledger.season = SEASON;
  ledger.note =
    "Week openers, frozen the first time a game is part of the display week and has a live line. " +
    "Never overwritten. Kickoffs are cached so week boundaries survive an ESPN outage.";
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
}

process.stderr.write(
  `\nWrote ${OUT}\n` +
  `  teams=${teams.length}  games=${G.size}  live-overrides=${overrides}  source=${out.source}\n` +
  `  phase=${phase}  display_week=${displayWeek ?? "—"}  ` +
  `week-games=${weekBlock ? weekBlock.games.length : 0}  pinned=${pinnedBlock ? pinnedBlock.games.length : 0}\n` +
  `  openers frozen this run: ${frozen}  (ledger holds ${Object.keys(ledger.openers).length})\n`
);
if (weekBlock) {
  const ranked = weekBlock.games
    .flatMap((g) => [g.home, g.away])
    .filter((t) => t.implied != null && !t.awaiting)
    .sort((a, b) => b.implied - a.implied);
  if (ranked.length) {
    process.stderr.write(`  week ${displayWeek} leader: ${ranked[0].name} ${ranked[0].implied}\n`);
  }
  const waiting = weekBlock.games.filter((g) => g.awaiting).length;
  if (waiting) process.stderr.write(`  awaiting a live line: ${waiting} game(s)\n`);
}
process.stderr.write(
  `  season top: ${teams[0].name} ${teams[0].ppg} ppg | playoff leader: ` +
  `${teams.slice().sort((a,b)=>b.playoff-a.playoff)[0].name}\n`
);
