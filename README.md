# NFL Implied Team Totals — data feed

Auto-updating implied team totals for all 32 NFL teams, all 272 games of the 2026 season.
Powers the implied-totals tool on Sharp Football Analysis.

```
implied team total = game total ÷ 2 − team spread ÷ 2
```

## What this repo does

A GitHub Action runs every 3 hours, merges two layers of **real Vegas lines**, and commits `implied-totals.json`.

1. **Open** — DraftKings full-season lines, captured at schedule release. Covers all 272 games from day one. (`baseline-2026-dk.json`)
2. **Live** — ESPN's free public API. As each game's current market line posts, it **overrides** the opener for that game.

There is no projection model anywhere. Every number traces back to a posted sportsbook line.

## In-season behaviour

The tool has three views, all from one feed and one URL:

| View | What it shows |
|---|---|
| **Week N** | Every team's implied total for the current week, sortable, with the week's opening number and the movement since. |
| **Matchups** | The same games grouped by kickoff slot. |
| **Full Season** | Rest-of-season implied average, plus fantasy playoff weeks 15–17. |

Before Week 1 and after Week 18 the weekly tabs are hidden and the tool opens on Full Season.

### Rest of season

The Full Season tab's headline column is the **rest-of-season** average: the implied totals for games that have not happened yet. A game leaves the average only when it is **final**, so the current week stays in it through Sunday.

The column relabels itself so the three states are never confused:

| State | Column | Shows |
|---|---|---|
| Before week 1 | `Pts / Game` | full 17-game average |
| In season | `Rest of Season` | average over games left |
| After week 18 | `Season Avg` | full 17-game average |

Expanding a team shows all 18 weeks. Weeks already played show the **actual points scored** on a solid slate bar; upcoming weeks show the implied total on the heat ramp. The header counts the games left.

The feed keeps `ppg` (all 17 games, unchanged) alongside `ppg_rest` and `games_left`, so nothing downstream breaks.

### When the week flips

`display_week` flips at **Monday 00:00 ET** — overnight Sunday, so the new week is live on Monday morning, by which point the book has posted it.

The boundary is derived from real kickoff timestamps, **not** from ESPN's `week.number` (which rolls over late — clicking "schedule" on ESPN on a Tuesday can still show you the previous week) and **not** from a hardcoded calendar:

```
displayStart(W) = Monday 00:00 ET on or before W's earliest kickoff
```

That one rule handles flexes, Thanksgiving, the Saturday games in Weeks 15–18, and the Wednesday Week 1 opener with no special-casing. For 2026 it puts Week 1 live on **Sept 7**.

### Pinned games

When the table flips on Monday, the previous week's Monday night game does not disappear. It stays **pinned above the new week**, clearly labelled as belonging to the old week, and carries its **final score** until **Tuesday 05:00 ET**.

Anything from the previous week that is still not final rides along in the same band. If ESPN's status flags go stale and more than four games look unfinished, the build stops trusting the flags and keeps only the genuine Monday-or-later kickoffs — otherwise a bad feed would pin the entire slate.

### Week openers and movement

ESPN publishes lookahead numbers for all 272 games months ahead, so "the first live line we ever saw" is **not** the week's opener — it would anchor Week 6's movement to a July number.

Instead the opener is frozen the first time a game is part of the **display week** and has a real line: at the Monday flip, or the first run after it where a live line exists. Frozen values live in `week-openers.json` and are never overwritten.

A game that reaches the flip with no real line yet is flagged `awaiting`, **sorts to the bottom** of the weekly table, and shows no movement until its line posts. Teams on bye sit below those.

## Files

| File | Purpose |
|---|---|
| `baseline-2026-dk.json` | All 272 games — DraftKings opening spread + total. Source of truth. |
| `build-implied-totals.mjs` | Merges baseline + live ESPN lines → `implied-totals.json`. |
| `week-openers.json` | Frozen week openers + cached kickoff times. Append-only ledger. |
| `implied-totals.json` | **The published feed.** This is what the website reads. |
| `embed.template.html` | The Avada embed, before data injection. Hand-edit this one. |
| `build-embed.mjs` | Injects the feed into the template → `implied-totals-WP.html` + `index.html`. |
| `implied-totals-WP.html` | **Paste this into the Avada Code Block.** Generated — do not hand-edit. |
| `index.html` | Standalone GitHub Pages preview. Generated — do not hand-edit. |
| `.github/workflows/update.yml` | Refresh every 3 hours at :20. |

`week-openers.json` is the one piece of state that cannot be rebuilt from scratch — delete it mid-season and every week opener is lost. It is committed on every run.

## The feed

```
https://raw.githubusercontent.com/USER/REPO/main/implied-totals.json
```

Or, with GitHub Pages enabled (Settings → Pages → Deploy from branch `main` / root):

```
https://USER.github.io/REPO/implied-totals.json
```

Both serve `Access-Control-Allow-Origin: *`, so the browser embed can fetch either. Pages is preferred — lower latency and a cleaner cache story.

### Shape

```jsonc
{
  "updated": "8/11 Tue",
  "season": 2026,
  "source": "mixed",           // "open" | "mixed"
  "phase": "in_season",        // "preseason" | "in_season" | "offseason"
  "display_week": 6,           // null outside the regular season
  "week": {                    // null outside the regular season
    "number": 6,
    "start": "2026-10-12T04:00:00.000Z",   // the Monday 00:00 ET flip
    "games": [
      {
        "wk": 6,
        "kickoff": "2026-10-18T17:00:00.000Z",
        "slot": "Sun 1:00 PM", "day": "Sun, 10/18",
        "state": "pre",        // pre | in | post
        "completed": false,
        "total": 47.5, "total_open": 46.5,
        "spread": -3.5, "spread_open": -3.0,   // home spread, negative = home favoured
        "awaiting": false,     // true = still on the DK baseline, no week line yet
        "home": {
          "abbr": "KC", "name": "Chiefs", "color": "#E31837", "opp": "LV",
          "implied": 25.5,     // current
          "open": 24.8,        // frozen at the Monday flip
          "move": 0.7,         // current - open
          "src": "live", "awaiting": false, "score": null
        },
        "away": { }
      }
    ]
  },
  "pinned": {                  // null unless last week has leftovers in the window
    "number": 5,
    "games": [ /* same game shape, carrying final scores */ ]
  },
  "playoff_weeks": [15, 16, 17],
  "teams": [                   // sorted by ppg, descending
    {
      "abbr": "LAR", "name": "Rams", "color": "#003594",
      "ppg": 26.7,           // all 17 games
      "ppg_rest": 25.9,      // games still to play; null once none are left
      "games_left": 12,
      "total": 452.7, "playoff": 78.8,
      "w15": 29.3, "w16": 23.0, "w17": 26.5,
      "bye": 11,
      "games": [
        { "wk": 1, "opp": "SF", "pts": 26.0, "src": "live",
          "played": true, "score": 24, "opp_score": 20 },   // score only once final
        { "wk": 2, "opp": "NYG", "pts": 28.5, "src": "live" }
      ],
      "games_live": 17, "games_open": 0
    }
  ]
}
```

Every game carries a `src` of `open` (DraftKings opener) or `live` (current market), so the UI can label the provenance of each number.

## Run it locally

```bash
node build-implied-totals.mjs                 # fetch ESPN, write implied-totals.json
node build-implied-totals.mjs --offline       # baseline + cached kickoffs, no network
node build-embed.mjs                          # rebuild the Avada paste
```

Requires Node 18+. Zero dependencies.

### Testing the season transition

Two flags make the in-season behaviour reproducible without waiting for September:

```bash
# pretend it is a given instant
node build-implied-totals.mjs --now=2026-09-14T08:20Z

# read week JSON from a local cache instead of hitting ESPN
node build-implied-totals.mjs --cache=./espn-cache

# do not write the opener ledger (leave week-openers.json alone)
node build-implied-totals.mjs --dry
```

Populate a cache with `curl ".../scoreboard?dates=2026&seasontype=2&week=N" -o espn-cache/wN.json`.

Useful instants for 2026: `2026-09-07T09:00Z` (Week 1 goes live), `2026-09-14T08:20Z` (flip to Week 2, Week 1's Monday game pinned), `2026-09-15T10:00Z` (pinned band drops).

## Rebuilding the baseline

If the books move significantly and you re-copy the DraftKings sheet:

```bash
python3 convert-baseline.py "Calcs to get lines for games.xlsx" baseline-2026-dk.json
```

The converter validates integrity (272 unique games, mirrored spreads, matching totals) and repairs rows where a price was pasted into a spread cell.

## Validation

Season averages match FirstDown Studio's published numbers within **0.15 pts on average** (max 0.40), with identical ordering — confirming the full-season book-line approach rather than a model.

The Action also runs a sanity check on every build and refuses to commit if it fails: 32 teams, 544 team-games, per-team PPG and playoff arithmetic, phase/`display_week` agreement, no team appearing twice in a week, movement equal to current minus the frozen opener, no `awaiting` game claiming an opener, and no implausible wall of pinned games. If the display week itself fails to load from ESPN, the build errors out rather than publishing an empty week — the last good feed stays live and the next run is only three hours away.

## Note on the pasted embed

`implied-totals-WP.html` is a snapshot in two layers. The **pre-rendered rows** are what crawlers and no-JS visitors see; they are frozen at the moment you paste. The **live fetch** pulls `implied-totals.json` on every page load and re-renders everything, including flipping the tool from the season view into the weekly view on its own.

So for visitors, paste once and it stays current. For crawlers, the baked snapshot goes stale at whatever week you last pasted. Repaste after Week 1 goes live so the weekly table is in the crawlable HTML; after that it is optional.
