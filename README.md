# NFL Implied Team Totals — data feed

Auto-updating implied team totals for all 32 NFL teams, all 272 games of the 2026 season.
Powers the implied-totals tool on Sharp Football Analysis.

```
implied team total = game total ÷ 2 − team spread ÷ 2
```

## What this repo does

A GitHub Action runs daily, merges two layers of **real Vegas lines**, and commits `implied-totals.json`.

1. **Open** — DraftKings full-season lines, captured at schedule release. Covers all 272 games from day one. (`baseline-2026-dk.json`)
2. **Live** — ESPN's free public API. As each game's current market line posts, it **overrides** the opener for that game.

There is no projection model anywhere. Every number traces back to a posted sportsbook line.

## Files

| File | Purpose |
|---|---|
| `baseline-2026-dk.json` | All 272 games — DraftKings opening spread + total. Source of truth. |
| `build-implied-totals.mjs` | Merges baseline + live ESPN lines → `implied-totals.json`. |
| `implied-totals.json` | **The published feed.** This is what the website reads. |
| `.github/workflows/update.yml` | Daily refresh at 13:00 UTC (9am ET). |

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
  "updated": "7/11 Sat",
  "season": 2026,
  "source": "open",            // "open" | "mixed"
  "teams": [                   // sorted by avg, descending
    { "abbr": "LAR", "name": "Rams", "color": "#003594",
      "avg": 26.5, "games": 17, "games_live": 0, "games_open": 17 }
  ],
  "playoffs": {
    "available": true,
    "weeks": [15, 16, 17],
    "teams": [                 // sorted by 3-week total, descending
      { "abbr": "BUF", "name": "Bills", "total": 79.0, "live": false,
        "w15": { "opp": "CHI", "pts": 27.5, "src": "open" },
        "w16": { "opp": "DEN", "pts": 24.0, "src": "open" },
        "w17": { "opp": "MIA", "pts": 27.5, "src": "open" } }
    ]
  }
}
```

Every game carries a `src` of `open` (DraftKings opener) or `live` (current market), so the UI can label the provenance of each number.

## Run it locally

```bash
node build-implied-totals.mjs                 # fetch ESPN, write implied-totals.json
node build-implied-totals.mjs --offline       # baseline only, no network
```

Requires Node 18+. Zero dependencies.

## Rebuilding the baseline

If the books move significantly and you re-copy the DraftKings sheet:

```bash
python3 convert-baseline.py "Calcs to get lines for games.xlsx" baseline-2026-dk.json
```

The converter validates integrity (272 unique games, mirrored spreads, matching totals) and repairs rows where a price was pasted into a spread cell.

## Validation

Season averages match FirstDown Studio's published numbers within **0.15 pts on average** (max 0.40), with identical ordering — confirming the full-season book-line approach rather than a model.
