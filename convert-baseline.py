#!/usr/bin/env python3
"""
convert-baseline.py — Sharp Football implied totals

Converts "Calcs to get lines for games.xlsx" (DraftKings full-season lines,
copied at schedule release) into baseline-2026-dk.json.

That baseline is the SOURCE OF TRUTH for all 272 games. The Node engine
(build-implied-totals.mjs) then overrides individual games with fresher
ESPN lines as each week's real number is posted.

Usage:
    python3 convert-baseline.py "Calcs to get lines for games.xlsx" baseline-2026-dk.json

Implied total = total/2 - team_spread/2   (team_spread positive = underdog)

Data repair: at schedule release a few Week-18 rows had a price (e.g. -110)
pasted into the spread cell. Any |spread| > 25 is rebuilt from the opponent's
spread, which is intact. Verified to yield 272/272 clean games.
"""
import json
import sys
from collections import defaultdict

import openpyxl

SRC = sys.argv[1] if len(sys.argv) > 1 else "Calcs to get lines for games.xlsx"
OUT = sys.argv[2] if len(sys.argv) > 2 else "baseline-2026-dk.json"

# sheet uses "LA" for the Rams; ESPN uses "LAR". Normalize to ESPN's keys.
NORM = {"LA": "LAR", "WSH": "WAS"}
norm = lambda a: NORM.get(a.strip(), a.strip())

NAME = {
    "ARI": "Cardinals", "ATL": "Falcons", "BAL": "Ravens", "BUF": "Bills",
    "CAR": "Panthers", "CHI": "Bears", "CIN": "Bengals", "CLE": "Browns",
    "DAL": "Cowboys", "DEN": "Broncos", "DET": "Lions", "GB": "Packers",
    "HOU": "Texans", "IND": "Colts", "JAX": "Jaguars", "KC": "Chiefs",
    "LV": "Raiders", "LAC": "Chargers", "LAR": "Rams", "MIA": "Dolphins",
    "MIN": "Vikings", "NE": "Patriots", "NO": "Saints", "NYG": "Giants",
    "NYJ": "Jets", "PHI": "Eagles", "PIT": "Steelers", "SF": "49ers",
    "SEA": "Seahawks", "TB": "Buccaneers", "TEN": "Titans", "WAS": "Commanders",
}


def num(x):
    return float(str(x).replace("−", "-"))  # unicode minus -> ascii


def main():
    wb = openpyxl.load_workbook(SRC, data_only=True)
    ws = wb["Full Schedule"]

    rows = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        if not r[2]:
            continue
        rows.append([int(num(r[0])), norm(r[2]), norm(r[3]), num(r[6]), num(r[7])])

    # --- repair: a stray price in the spread cell -> rebuild from opponent ---
    idx = {(w, t): i for i, (w, t, o, s, tot) in enumerate(rows)}
    repaired = 0
    for i, (w, t, o, s, tot) in enumerate(rows):
        if abs(s) > 25:
            rows[i][3] = -rows[idx[(w, o)]][3]
            repaired += 1

    # --- integrity: every game must appear twice, spreads opposite, totals equal ---
    pairs = defaultdict(list)
    for w, t, o, s, tot in rows:
        pairs[(w, frozenset([t, o]))].append((t, s, tot))
    bad = [
        k for k, v in pairs.items()
        if len(v) != 2 or abs(v[0][1] + v[1][1]) > 1e-6 or abs(v[0][2] - v[1][2]) > 1e-6
    ]

    games = [
        {
            "wk": w,
            "team": t,
            "opp": o,
            "spread": s,
            "total": tot,
            "implied": round(tot / 2 - s / 2, 2),
        }
        for w, t, o, s, tot in rows
    ]

    teams = sorted({g["team"] for g in games})
    out = {
        "season": 2026,
        "source": "draftkings-open",
        "note": "DraftKings full-season lines copied at schedule release. Overridden per-game by live ESPN lines as they post.",
        "names": NAME,
        "games": games,
    }
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))

    print(f"rows............ {len(rows)}")
    print(f"repaired........ {repaired}")
    print(f"unique games.... {len(pairs)}")
    print(f"integrity fails. {len(bad)}")
    print(f"teams........... {len(teams)}")
    print(f"wrote........... {OUT}")


if __name__ == "__main__":
    main()
