/**
 * The rulebook's own tests.
 *
 * This file is synced into both apps alongside `rubric.ts`, so the shared
 * repository and the two applications all assert the same behaviour from the
 * same source. It exports a function rather than registering a test framework
 * so each app can fold it into whatever smoke runner it already has.
 */

import {
  DEFAULT_CARD_GEOMETRY,
  RULES,
  confidenceFromTally,
  gradeFromObservations,
  measureImperfection,
  pointsToGrade,
  severityForMeasure,
  tally,
  type TallyObservation,
} from "./rubric";

export interface RubricTestResult {
  name: string;
  ok: boolean;
  detail: string;
}

function expect(results: RubricTestResult[], name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({
    name,
    ok,
    detail: ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  });
}

/** The card that motivated this rulebook: a pinpoint of white on the back and
 *  a short section of visible holo layer on the top edge of the front. */
const PINPOINT_AND_HOLO: TallyObservation[] = [
  { type: "Surface Wear", side: "back", measure: 1 },
  { type: "Edgewear", side: "front", measure: 12 },
];

export function runRubricTests(): RubricTestResult[] {
  const results: RubricTestResult[] = [];

  // ── The worked example ─────────────────────────────────────────────────────
  const pinpoint = tally(PINPOINT_AND_HOLO);
  expect(results, "pinpoint surface wear + holo edge is LP, not MP", pinpoint.condition, "LP");
  expect(results, "worked example is worth two points", pinpoint.points, 2);
  expect(results, "worked example points grade is NM", pinpoint.pointsGrade, "NM");
  expect(results, "worked example allowance grade is LP", pinpoint.allowanceGrade, "LP");
  expect(results, "worked example is not borderline", pinpoint.borderline, false);
  expect(results, "worked example label", pinpoint.label, "LP");

  const asIndent = tally([
    { type: "Indentation", side: "back", measure: 0.5 },
    { type: "Edgewear", side: "front", measure: 12 },
  ]);
  expect(results, "a pinpoint indent instead of wear is NM", asIndent.condition, "NM");

  // ── Points scale ───────────────────────────────────────────────────────────
  expect(results, "0 points is NM", pointsToGrade(0), "NM");
  expect(results, "3 points is NM", pointsToGrade(3), "NM");
  expect(results, "4 points is LP", pointsToGrade(4), "LP");
  expect(results, "6 points is LP", pointsToGrade(6), "LP");
  expect(results, "7 points is MP", pointsToGrade(7), "MP");
  expect(results, "12 points is MP", pointsToGrade(12), "MP");
  expect(results, "13 points is HP", pointsToGrade(13), "HP");
  expect(results, "24 points is HP", pointsToGrade(24), "HP");
  expect(results, "25 points is DMG", pointsToGrade(25), "DMG");

  // ── Borderline modifier fires exactly at the cap ───────────────────────────
  const threeIndents = tally([
    { type: "Indentation", measure: 0.5 },
    { type: "Indentation", measure: 0.5 },
    { type: "Indentation", measure: 0.5 },
  ]);
  expect(results, "three slight indents are NM", threeIndents.condition, "NM");
  expect(results, "three slight indents are borderline", threeIndents.label, "NM-");
  expect(results, "borderline alternate reading", threeIndents.alternateLabel, "LP+");

  const twoEdgewear = tally([
    { type: "Edgewear", measure: 25 },
    { type: "Edgewear", measure: 25 },
  ]);
  expect(results, "two minor edgewear is LP", twoEdgewear.condition, "LP");
  expect(results, "two minor edgewear is four points", twoEdgewear.points, 4);
  expect(results, "two minor edgewear is not borderline", twoEdgewear.label, "LP");

  // ── Per type allowances ────────────────────────────────────────────────────
  expect(results, "slight surface wear rules out NM", tally([{ type: "Surface Wear", measure: 1 }]).condition, "LP");
  expect(results, "major surface wear is DMG", tally([{ type: "Surface Wear", measure: 60 }]).condition, "DMG");
  expect(results, "slight grime rules out NM", tally([{ type: "Grime", measure: 1 }]).condition, "LP");
  expect(results, "major grime is DMG", tally([{ type: "Grime", measure: 30 }]).condition, "DMG");
  expect(results, "minor edgewear rules out NM", tally([{ type: "Edgewear", measure: 25 }]).condition, "LP");
  expect(results, "moderate edgewear caps at MP", tally([{ type: "Edgewear", measure: 100 }]).condition, "MP");
  expect(results, "major edgewear caps at HP", tally([{ type: "Edgewear", measure: 200 }]).condition, "HP");
  expect(results, "a 30mm scratch is NM", tally([{ type: "Scratch", measure: 30 }]).condition, "NM");
  expect(results, "a 60mm scratch caps at MP", tally([{ type: "Scratch", measure: 60 }]).condition, "MP");
  expect(results, "slight scuffing is NM", tally([{ type: "Scuffing", measure: 200 }]).condition, "NM");
  expect(results, "minor scuffing caps at LP", tally([{ type: "Scuffing", measure: 1000 }]).condition, "LP");
  expect(results, "moderate scuffing caps at MP", tally([{ type: "Scuffing", measure: 3000 }]).condition, "MP");
  expect(results, "a pinpoint indent is NM", tally([{ type: "Indentation", measure: 0.5 }]).condition, "NM");
  expect(results, "a minor indent caps at LP", tally([{ type: "Indentation", measure: 3 }]).condition, "LP");
  expect(results, "a moderate indent caps at MP", tally([{ type: "Indentation", measure: 10 }]).condition, "MP");
  expect(results, "slight fault caps at MP", tally([{ type: "Fault", measure: 1 }]).condition, "MP");
  expect(results, "moderate fault is DMG", tally([{ type: "Fault", measure: 20 }]).condition, "DMG");
  expect(results, "slight defect is NM", tally([{ type: "Defect", measure: 1 }]).condition, "NM");
  expect(results, "minor defect caps at LP", tally([{ type: "Defect", measure: 3 }]).condition, "LP");
  expect(results, "moderate defect caps at HP", tally([{ type: "Defect", measure: 7 }]).condition, "HP");
  expect(results, "major defect is DMG", tally([{ type: "Defect", measure: 20 }]).condition, "DMG");

  // ── Hard rules ─────────────────────────────────────────────────────────────
  expect(results, "damage is DMG", tally([{ type: "Damage" }]).condition, "DMG");
  expect(
    results,
    "an integrity defect is DMG",
    tally([{ type: "Defect", measure: 1, integrity: true }]).condition,
    "DMG",
  );
  expect(
    results,
    "a crease caps the card at MP",
    tally([{ type: "Bend", measure: 5, crease: true }]).condition,
    "MP",
  );
  expect(results, "a minor bend caps at LP", tally([{ type: "Bend", measure: 8 }]).condition, "LP");
  expect(results, "a moderate bend caps at MP", tally([{ type: "Bend", measure: 15 }]).condition, "MP");
  expect(results, "curling past 5mm is DMG", tally([{ type: "Curling", measure: 7 }]).condition, "DMG");
  expect(results, "curling up to 5mm is NM", tally([{ type: "Curling", measure: 3 }]).condition, "NM");

  // ── Measurements ───────────────────────────────────────────────────────────
  const topEdge = measureImperfection(
    "Edgewear",
    { x: 0.4, y: 0, w: 0.2, h: 0.02 },
    DEFAULT_CARD_GEOMETRY,
  );
  expect(results, "top edge wear is measured along the edge", Math.round((topEdge?.measure ?? 0) * 100) / 100, 12.6);

  const spot = measureImperfection(
    "Surface Wear",
    { x: 0.5, y: 0.5, w: 1 / 63, h: 1 / 88 },
    DEFAULT_CARD_GEOMETRY,
  );
  expect(results, "a 1/63 by 1/88 spot is 1mm2", Math.round((spot?.measure ?? 0) * 100) / 100, 1);

  const linear = measureImperfection(
    "Indentation",
    { x: 0.5, y: 0.5, w: 0.2, h: 0.005 },
    DEFAULT_CARD_GEOMETRY,
  );
  expect(results, "a long thin indent is measured by length", linear?.linear, true);
  expect(results, "the linear indent length", Math.round((linear?.measure ?? 0) * 100) / 100, 12.6);

  expect(results, "20mm of edgewear is Slight", severityForMeasure(RULES.Edgewear.bands, 20), "Slight");
  expect(results, "21mm of edgewear is Minor", severityForMeasure(RULES.Edgewear.bands, 21), "Minor");

  // --- Measuring what the model reported -------------------------------------
  const wholeCard = [
    { label: "front of the card, the whole card", cardRegion: { x: 0, y: 0, w: 1, h: 1 }, measurable: false },
  ];
  const closeUp = [
    { label: "front of the card, the bottom edge, close up", cardRegion: { x: 0.2, y: 0.932, w: 0.6, h: 0.068 }, measurable: true },
  ];

  // A generous box on a whole-card shot is a guess about extent, and the
  // severity bands punish a generous guess. The model's own severity wins.
  const coarse = gradeFromObservations(
    [
      {
        image: "front of the card, the whole card",
        type: "Edgewear",
        side: "front",
        bbox: [0.04, 0.945, 0.55, 0.025],
        severity: "Slight",
        confidence: 0.4,
      },
    ],
    wholeCard
  );
  expect(results, "a whole-card shot is judged on the model's severity", coarse.condition, "NM");
  expect(results, "a whole-card shot stays one point", coarse.points, 1);

  // On a close-up the box is tight enough to measure, and the measurement —
  // not the model's guess — decides the band.
  const precise = gradeFromObservations(
    [
      {
        image: "front of the card, the bottom edge, close up",
        type: "Edgewear",
        side: "front",
        bbox: [0.05, 0.05, 0.9, 0.9],
        severity: "Slight",
        confidence: 0.7,
      },
    ],
    closeUp
  );
  expect(results, "a close-up is measured rather than labelled", precise.points, 2);
  expect(results, "a measured close-up caps at LP", precise.condition, "LP");

  // A measurement that contradicts the model by more than one band means the
  // box is wrong, not that the defect is worse than it looks.
  const contradicted = gradeFromObservations(
    [
      {
        image: "front of the card, the bottom edge, close up",
        type: "Surface Wear",
        side: "front",
        bbox: [0.0, 0.0, 0.99, 0.99],
        severity: "Slight",
        confidence: 0.5,
      },
    ],
    closeUp
  );
  expect(results, "a box that contradicts the model is discarded", contradicted.points, 1);

  // ── Evidence confidence ────────────────────────────────────────────────────
  const goodPhotos = [
    { id: "front" as const, width: 2700, height: 3770, sharpness: 220, brightness: 142, glare: 0.01 },
    { id: "back" as const, width: 2700, height: 3770, sharpness: 210, brightness: 138, glare: 0.02 },
    { id: "surface" as const, width: 2600, height: 3300, sharpness: 120, brightness: 92, glare: 0.03 },
  ];
  const good = confidenceFromTally(precise, { photos: goodPhotos, imagesSent: 23 });
  expect(results, "good evidence scores high", good.score >= 85, true);
  expect(results, "good evidence is the high band", good.band, "high");
  expect(results, "good evidence needs no advice", good.reasons, []);

  const roughPhotos = [
    { id: "front" as const, width: 1300, height: 1815, sharpness: 30, brightness: 120, glare: 0.12 },
    { id: "back" as const, width: 1300, height: 1815, sharpness: 35, brightness: 118, glare: 0.12 },
  ];
  const rough = confidenceFromTally(coarse, { photos: roughPhotos, imagesSent: 14 });
  expect(results, "a low-resolution soft set scores low", rough.score < 65, true);
  expect(results, "a low-resolution soft set is the low band", rough.band, "low");
  expect(
    results,
    "the low-resolution reason is named",
    rough.reasons.some((reason) => reason.includes("px per mm")),
    true,
  );

  const partial = confidenceFromTally(precise, {
    photos: goodPhotos.slice(0, 2),
    imagesSent: 14,
  });
  expect(results, "missing the surface shot lowers the score", partial.score < good.score, true);
  expect(
    results,
    "the missing surface shot is named",
    partial.reasons.some((reason) => reason.includes("raking-light")),
    true,
  );

  const borderline = confidenceFromTally(threeIndents, { photos: goodPhotos, imagesSent: 23 });
  const clean = confidenceFromTally(tally([{ type: "Indentation", measure: 0.5 }]), {
    photos: goodPhotos,
    imagesSent: 23,
  });
  expect(results, "a borderline card scores lower than a clean one", borderline.score < clean.score, true);

  const disputed = confidenceFromTally(contradicted, { photos: goodPhotos, imagesSent: 23 });
  expect(results, "a contradicting box lowers the score", disputed.score < clean.score, true);
  expect(
    results,
    "a contradicting box is named",
    disputed.reasons.some((reason) => reason.includes("disagreed")),
    true,
  );

  return results;
}
