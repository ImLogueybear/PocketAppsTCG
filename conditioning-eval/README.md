# Conditioning evaluation set

Cards with a condition a vendor agreed on, plus the photos that card was
graded from. The runner sends the photos to the grading service, applies the
TCGplayer rulebook to what comes back, and reports how often the app agrees
with the vendor.

```bash
node scripts/eval-conditioning.mjs
node scripts/eval-conditioning.mjs --case <id>
node scripts/eval-conditioning.mjs --url http://localhost:8787 --min-agreement 0.8
node scripts/eval-conditioning.mjs --matrix "deepseek:deepseek-flash,ollama:gemma4:31b"
```

`--url` points at a local worker (`npm run build:worker && npx wrangler dev`)
so a rubric change can be checked before it is deployed. `--matrix` runs every
case against each candidate (provider:model) so two models see exactly the same
photos. The service must allow the override (`CONDITION_ALLOW_CALLER_KEY=1` with
a caller key) or be a staging deployment configured with
`CONDITION_PROVIDER`/`CONDITION_MODEL`.

Every run writes `conditioning-eval/report.json` and `report.md`: exact and
within-one agreement, mean reliability, a confidence-calibration table
(reliability bucket → observed exact rate) and per-type missed/spurious counts.

## Adding a case

1. Put the photos in `cases/<id>/`.
2. Add an entry to `manifest.json`:

```jsonc
{
  "id": "wotc-pikachu-4-pinpoint",
  "card": {
    "name": "Pikachu",
    "setName": "Base Set",
    "number": "4",
    "holo": true
  },
  "photos": [
    { "label": "front of the card, the whole card", "file": "conditioning-eval/cases/wotc-pikachu-4-pinpoint/front.jpg" },
    { "label": "back of the card, the whole card", "file": "conditioning-eval/cases/wotc-pikachu-4-pinpoint/back.jpg" }
  ],
  "expected": {
    "condition": "LP",
    "points": 2,
    "imperfections": [
      { "type": "Surface Wear", "severity": "Slight", "side": "back" },
      { "type": "Edgewear", "severity": "Slight", "side": "front" }
    ],
    "note": "One pinpoint of white on the back, a short section of visible holo layer on the top edge of the front."
  }
}
```

`condition` is the TCGplayer condition the card qualifies for under the
standard, and `imperfections` is the list of defects the vendor could see.
`points` is optional and only used as extra information.

**Whole-card photos are the norm.** The apps send the corner and edge close-ups
as separate images, and a bounding box on a close-up is measured against the
card while one on a whole-card shot is not. A case can include close-ups too —
give the photo a `cardRegion` (the part of the card it covers, in card
coordinates) and `"measurable": true`:

```jsonc
{ "label": "front of the card, the top-left corner, close up",
  "file": "conditioning-eval/cases/.../front-tl.jpg",
  "cardRegion": { "x": 0, "y": 0, "w": 0.254, "h": 0.182 },
  "measurable": true }
```

Without a `cardRegion` the photo is treated as the whole card and is judged on
the model's own severity, which is what the apps do with whole-card shots.

## The first case

The case this set exists for: a WotC Pokemon card with **one pinpoint of white
on the back** and **a short section of visible holo layer on the top edge of
the front**. Those are the only issues.

- Pinpoint of white on the back → Surface Wear, Slight (≤2.5 mm²) = 1 point.
- Visible holo layer on the top edge → Edgewear, Slight (≤20 mm) = 1 point.
- Two points. Near Mint allows three, but Surface Wear is not allowed at Near
  Mint at all, so the card is **LP**.

A vendor called it MP. The card should not come back MP.

## What the runner reports

- **exact** — the condition matched the expectation.
- **within one grade** — off by at most one step (NM/LP/MP/HP/DMG).
- **missed** — an expected imperfection type the service did not report.
- **extra** — a type the service reported that the vendor did not list.
- **reliability** — the score the app would show, from the shared
  `confidenceFromTally`. Node has no image decoder here, so sharpness, brightness
  and glare are neutral for every case. Those terms are identical across models,
  so compare candidates on the same photos and treat the absolute number as an
  upper bound.

The missed/extra columns are the useful ones: they say whether a rulebook
change or a prompt change actually improved the *perception*, which a grade
alone cannot tell you.
