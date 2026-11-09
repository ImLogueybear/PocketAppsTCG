/**
 * TCGplayer card conditioning rulebook — the single source of truth shared by
 * PocketVendorTCG, PocketVaultTCG and PocketScanTCG.
 *
 * This file is deliberately dependency-free and DOM-free so the exact same code
 * runs in three places:
 *
 *   1. the PocketAppsTCG conditioning Worker, which prompts the vision model;
 *   2. PocketVendorTCG / PocketVaultTCG, which turn the model's observations
 *      into a condition with a deterministic tally;
 *   3. the offline manual checklist, which feeds the same tally.
 *
 * It is synced into the apps by `scripts/sync-conditioning.mjs`; never edit the
 * copies in the apps directly.
 *
 * ── Sources ──────────────────────────────────────────────────────────────────
 *
 *   S1  Card Conditioning Standards (PDF, "Updated October 2026")
 *       https://mktg-assets.tcgplayer.com/web/seller/guides/Card-Conditioning-Standards.pdf
 *       S1 is the operational document: it carries the points system, the
 *       per-condition points caps and the "true standards and specific
 *       measurements" tables.
 *
 *   S2  Understanding Card Condition Imperfections: A Comprehensive Guide
 *       https://help.tcgplayer.com/hc/en-us/articles/26141121045143-Understanding-Card-Condition-Imperfections-A-Comprehensive-Guide
 *       S2 carries the prose definition of each severity band and the explicit
 *       "cannot be accepted at a condition higher than X" caps.
 *
 * Where S1 and S2 disagree, S1's measurement tables win, because S1 is the
 * document TCGplayer calls the true standards. The three known conflicts are
 * called out in the notes below.
 *
 * ── How a condition is derived ───────────────────────────────────────────────
 *
 * A condition is the *worst* of three independent answers:
 *
 *   • the points grade   — the best condition whose points cap the card's total
 *                          TCGplayer points fits under (NM 3, LP 6, MP 12, HP 24);
 *   • the allowance grade — the best condition at which every observed
 *                          imperfection is still permitted by that condition's
 *                          published severity + measurement allowance;
 *   • the hard rules      — Damage, an integrity-affecting Defect, a crease or
 *                          more than 5mm of curling put the card in DMG.
 *
 * The allowance grade is what makes a pinpoint of Surface Wear cap a card at LP
 * even when the card has only two points: Surface Wear is simply not allowed at
 * Near Mint (S1 page 7, "Not Allowed: Surface Wear, Grime, Bend, Fault, Damage").
 */

/** Bump when the rulebook changes; the Worker reports it so apps can go stale. */
export const RUBRIC_VERSION = "2026.11.08-1";

export const CONDITION_SOURCES = {
  overview:
    "https://help.tcgplayer.com/hc/en-us/articles/221430307-Card-Conditioning-Overview",
  standards:
    "https://mktg-assets.tcgplayer.com/web/seller/guides/Card-Conditioning-Standards.pdf",
  imperfections:
    "https://help.tcgplayer.com/hc/en-us/articles/26141121045143-Understanding-Card-Condition-Imperfections-A-Comprehensive-Guide",
} as const;

/** The five sellable conditions, best to worst. */
export const CONDITION_GRADES = ["NM", "LP", "MP", "HP", "DMG"] as const;
export type ConditionGrade = (typeof CONDITION_GRADES)[number];

export const SEVERITIES = ["Slight", "Minor", "Moderate", "Major"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** S1 page 12 — "Value of Imperfection Severity". */
export const SEVERITY_POINTS: Record<Severity, number> = {
  Slight: 1,
  Minor: 2,
  Moderate: 4,
  Major: 8,
};

/** S1 page 12 — "Allowable Points in Each Condition". */
export const CONDITION_POINTS_CAP = {
  NM: 3,
  LP: 6,
  MP: 12,
  HP: 24,
} as const;

/** The points cap of a grade, or Infinity for Damaged. */
export function pointsCap(grade: ConditionGrade): number {
  return grade === "DMG" ? Number.POSITIVE_INFINITY : CONDITION_POINTS_CAP[grade];
}

export const IMPERFECTION_TYPES = [
  "Edgewear",
  "Scuffing",
  "Scratch",
  "Surface Wear",
  "Grime",
  "Indentation",
  "Bend",
  "Curling",
  "Fault",
  "Defect",
  "Damage",
] as const;
export type ImperfectionType = (typeof IMPERFECTION_TYPES)[number];

/**
 * How a type is measured.
 * - `length` millimetres along the card edge or along the mark
 * - `area`   square millimetres of the card's surface
 * - `lift`   millimetres the card lifts off a flat surface
 * - `none`   not measurable (Damage)
 */
export type MeasureKind = "length" | "area" | "lift" | "none";

export interface SeverityBand {
  severity: Severity;
  /** Inclusive upper bound of the measurement for this band. */
  max: number;
}

/** What a single condition permits for one imperfection type. */
export interface Allowance {
  /** The worst severity this condition still permits, or null when the type is not allowed at all. */
  severity: Severity | null;
  /** The largest measurement this condition still permits. */
  max: number;
}

export interface ImperfectionRule {
  type: ImperfectionType;
  measure: MeasureKind;
  /** Measurement → severity. */
  bands: SeverityBand[];
  /** Condition → what that condition permits. */
  allowances: Record<ConditionGrade, Allowance>;
  /** Linear indents are measured by length instead of area (S2, Indentation). */
  linear?: {
    bands: SeverityBand[];
    allowances: Record<ConditionGrade, Allowance>;
  };
  note: string;
}

const NONE: Allowance = { severity: null, max: 0 };
const INF = Number.POSITIVE_INFINITY;

/**
 * The rulebook.
 *
 * `bands` come from the severity measurements in S2; `allowances` come from
 * S1's per-condition tables (pages 10–11). Both documents agree on every row
 * except the three called out in the notes.
 */
export const RULES: Record<ImperfectionType, ImperfectionRule> = {
  Edgewear: {
    type: "Edgewear",
    measure: "length",
    bands: [
      { severity: "Slight", max: 20 },
      { severity: "Minor", max: 80 },
      { severity: "Moderate", max: 160 },
      { severity: "Major", max: INF },
    ],
    allowances: {
      NM: { severity: "Slight", max: 20 },
      LP: { severity: "Minor", max: 80 },
      MP: { severity: "Moderate", max: 160 },
      HP: { severity: "Major", max: INF },
      DMG: { severity: "Major", max: INF },
    },
    note:
      "Loss of colour, gloss or material along edges, borders or corners. Instances less than 5mm apart count as one contiguous instance. Edgewear that reaches more than 0.5mm in from the edge is Surface Wear, not Edgewear.",
  },
  Scuffing: {
    type: "Scuffing",
    measure: "area",
    bands: [
      { severity: "Slight", max: 315 },
      { severity: "Minor", max: 2772 },
      { severity: "Moderate", max: 5544 },
      { severity: "Major", max: INF },
    ],
    allowances: {
      NM: { severity: "Slight", max: 315 },
      LP: { severity: "Minor", max: 2772 },
      MP: { severity: "Moderate", max: 5544 },
      HP: { severity: "Major", max: 11088 },
      DMG: { severity: "Major", max: INF },
    },
    note:
      "A group of scratches or abrasions that does not reveal material beneath the surface (that would be Surface Wear). 'Total scuffing' means no 5x5mm square on that side is free of scuffing. A card may hold two instances of Minor scuffing per side, or four per card.",
  },
  Scratch: {
    type: "Scratch",
    measure: "length",
    bands: [
      { severity: "Slight", max: 20 },
      { severity: "Minor", max: 40 },
      { severity: "Moderate", max: INF },
    ],
    allowances: {
      NM: { severity: "Minor", max: 40 },
      LP: { severity: "Minor", max: 40 },
      MP: { severity: "Moderate", max: INF },
      HP: { severity: "Major", max: INF },
      DMG: { severity: "Major", max: INF },
    },
    note:
      "A hairline mark that does not reveal material beneath the surface. Slight and Minor scratches are acceptable in every condition, so a scratch only starts costing a grade past 40mm.",
  },
  "Surface Wear": {
    type: "Surface Wear",
    measure: "area",
    bands: [
      { severity: "Slight", max: 2.5 },
      { severity: "Minor", max: 10 },
      { severity: "Moderate", max: 40 },
      { severity: "Major", max: INF },
    ],
    allowances: {
      NM: NONE,
      LP: { severity: "Slight", max: 2.5 },
      MP: { severity: "Minor", max: 10 },
      HP: { severity: "Moderate", max: 40 },
      DMG: { severity: "Major", max: INF },
    },
    note:
      "The colour layer has been buffed or scraped away so the base cardstock shows through — whitening, speckling. This is the imperfection that rules out Near Mint even when it is only a pinpoint.",
  },
  Grime: {
    type: "Grime",
    measure: "area",
    bands: [
      { severity: "Slight", max: 2.5 },
      { severity: "Minor", max: 13.75 },
      { severity: "Moderate", max: 27.5 },
      { severity: "Major", max: INF },
    ],
    allowances: {
      NM: NONE,
      LP: { severity: "Slight", max: 2.5 },
      MP: { severity: "Moderate", max: 27.5 },
      HP: { severity: "Moderate", max: 27.5 },
      DMG: { severity: "Major", max: INF },
    },
    note:
      "Dirt, smudges or play dirt that do not stain or physically alter the card. A substance that stains, leaves sticky residue or could be a biohazard is a Foreign Substance, which is Damage.",
  },
  Indentation: {
    type: "Indentation",
    measure: "area",
    bands: [
      { severity: "Slight", max: 1 },
      { severity: "Minor", max: 4 },
      { severity: "Moderate", max: 25 },
      { severity: "Major", max: INF },
    ],
    allowances: {
      NM: { severity: "Slight", max: 1 },
      LP: { severity: "Minor", max: 4 },
      MP: { severity: "Moderate", max: 25 },
      HP: { severity: "Major", max: INF },
      DMG: { severity: "Major", max: INF },
    },
    linear: {
      bands: [
        { severity: "Minor", max: 20 },
        { severity: "Moderate", max: 50 },
        { severity: "Major", max: INF },
      ],
      allowances: {
        NM: NONE,
        LP: { severity: "Minor", max: 20 },
        MP: { severity: "Moderate", max: 50 },
        HP: { severity: "Major", max: INF },
        DMG: { severity: "Major", max: INF },
      },
    },
    note:
      "A dent or impression that does not puncture the card and does not show through to the other side. One pinpoint is Slight and is allowed at Near Mint. An indent that punctures the card is Damage.",
  },
  Bend: {
    type: "Bend",
    measure: "length",
    bands: [
      { severity: "Minor", max: 10 },
      { severity: "Moderate", max: 20 },
      { severity: "Major", max: INF },
    ],
    allowances: {
      NM: NONE,
      LP: { severity: "Minor", max: 10 },
      MP: { severity: "Moderate", max: 20 },
      HP: { severity: "Major", max: INF },
      DMG: { severity: "Major", max: INF },
    },
    note:
      "The card has been folded over itself. There is no Slight bend. A bend that shows a crease drops the condition to Moderately Played at best; a bend that affects the card's structural integrity is Damage.",
  },
  Curling: {
    type: "Curling",
    measure: "lift",
    bands: [
      { severity: "Slight", max: 5 },
      { severity: "Major", max: INF },
    ],
    allowances: {
      NM: { severity: "Slight", max: 5 },
      LP: { severity: "Slight", max: 5 },
      MP: { severity: "Slight", max: 5 },
      HP: { severity: "Slight", max: 5 },
      DMG: { severity: "Major", max: INF },
    },
    note:
      "The card lifts off the surface it rests on. Up to 5mm of lift at the centre has no impact on condition; beyond 5mm the card is Damaged. Curling cannot be judged from a flat photo.",
  },
  Fault: {
    type: "Fault",
    measure: "area",
    bands: [
      { severity: "Slight", max: 2.5 },
      { severity: "Minor", max: 10 },
      { severity: "Moderate", max: 40 },
      { severity: "Major", max: INF },
    ],
    allowances: {
      NM: NONE,
      LP: NONE,
      MP: { severity: "Slight", max: 2.5 },
      HP: { severity: "Minor", max: 10 },
      DMG: { severity: "Major", max: INF },
    },
    note:
      "An expansion or splitting of the surface or material that does not compromise the card. Liquid exposure counts as a Fault. A Moderate or Major Fault defaults the card to Damaged.",
  },
  Defect: {
    type: "Defect",
    measure: "area",
    bands: [
      { severity: "Slight", max: 2.5 },
      { severity: "Minor", max: 5 },
      { severity: "Moderate", max: 10 },
      { severity: "Major", max: INF },
    ],
    allowances: {
      NM: { severity: "Slight", max: 2.5 },
      LP: { severity: "Minor", max: 5 },
      MP: { severity: "Minor", max: 5 },
      HP: { severity: "Moderate", max: 10 },
      DMG: { severity: "Major", max: INF },
    },
    note:
      "A production error: ink errors, blurred or missing ink, miscuts, crimping, missing or misplaced holo stamps, roller lines, foil bubbling. A Defect that compromises structure, playability or authentication is Damage.",
  },
  Damage: {
    type: "Damage",
    measure: "none",
    bands: [{ severity: "Major", max: INF }],
    allowances: {
      NM: NONE,
      LP: NONE,
      MP: NONE,
      HP: NONE,
      DMG: { severity: "Major", max: INF },
    },
    note:
      "Foreign substance, non-manufacturing ink, tear, hole, split, sun damage, puncture. Damage is always Damaged.",
  },
};

/** The rules in the order a vendor should look for them. */
export const RULE_ORDER: ImperfectionType[] = [
  "Edgewear",
  "Scuffing",
  "Scratch",
  "Surface Wear",
  "Grime",
  "Indentation",
  "Bend",
  "Curling",
  "Fault",
  "Defect",
  "Damage",
];

/** S1 pages 7–8 — the condition summaries and the types each condition forbids. */
export const CONDITION_SUMMARY: {
  id: ConditionGrade;
  label: string;
  points: number;
  summary: string;
  notAllowed: string[];
}[] = [
  {
    id: "NM",
    label: "Near Mint",
    points: 3,
    summary: "A card with minimal handling or play wear.",
    notAllowed: ["Surface Wear", "Grime", "Bend", "Fault", "Damage"],
  },
  {
    id: "LP",
    label: "Lightly Played",
    points: 6,
    summary: "Shows signs of handling or play, but does not display significant imperfections.",
    notAllowed: ["Fault", "Damage"],
  },
  {
    id: "MP",
    label: "Moderately Played",
    points: 12,
    summary: "Shows significant play, use or wear.",
    notAllowed: ["Damage"],
  },
  {
    id: "HP",
    label: "Heavily Played",
    points: 24,
    summary: "Shows significant wear and imperfections.",
    notAllowed: ["Damage"],
  },
  {
    id: "DMG",
    label: "Damaged",
    points: Number.POSITIVE_INFINITY,
    summary: "Shows wear or imperfections beyond the standards for other conditions.",
    notAllowed: [],
  },
];

/** Rules that apply across every imperfection type. */
export const SPECIAL_RULES: string[] = [
  "Centering: up to 70/30 has no impact on condition. Beyond that, list the card as a Listing with Photo at the condition it would qualify for without the shifting.",
  "Curling: up to 5mm of lift from a flat surface has no impact on condition. Beyond 5mm the card is Damaged.",
  "Oversized cards: 1.4x the size allowance applies to every severity measurement.",
  "Contiguous: imperfection instances less than 5mm apart count as a single instance. This matters most for Edgewear.",
  "Scuffing: 'total' means no 5x5mm square (25mm²) on that side is free of scuffing. A card that is not quite total is measured as two instances of Minor scuffing.",
  "A crease produced by a bend drops the condition to Moderately Played at best.",
  "Defects that compromise structure, playability or authentication — crimping, miscuts, missing or misplaced holo stamps, foil bubbling over 1mm, missing information — are Damaged. The card may still be listed as a Listing with Photo at the condition it would otherwise qualify for.",
  "Edgewear that reaches more than 0.5mm in from the edge is Surface Wear, not Edgewear.",
  "Peels under 2.5mm count as Slight Edgewear; a peel of 2.5mm to 5mm counts as Slight Fault; a peel over 5mm is Damage.",
  "A scratch that reveals the material beneath the surface is Surface Wear, not a Scratch.",
  "Mint and Gem Mint are not sold on TCGplayer, so they are not conditions we assign.",
];

/** Pokemon-specific readings of the general standard. */
export const POKEMON_NOTES: string[] = [
  "Roller lines and print lines are manufacturing Defects, not wear. On WotC-era (1999-2003) holo printings they are common enough to leave uncounted; on modern printings a roller line is a Slight Defect.",
  "Holo bleed on modern cards is a manufacturer characteristic: a Slight Defect at most, and only when it does not prevent the card being authenticated.",
  "Near-Mint-from-new WotC holo cards routinely carry fine surface scratches and light edge whitening. Count them under the normal bands and do not inflate them.",
  "Missing or misplaced holo stamps are integrity Defects and make the card Damaged.",
  "Standard Pokemon cards are 63mm x 88mm, the same as Magic and as TCG Pocket cards.",
];

/** The physical size of the cards we grade. */
export const CARD_SIZES = {
  standard: { widthMm: 63, heightMm: 88 },
  oversized: { widthMm: 88.2, heightMm: 123.2 },
} as const;

/** How far below the worst grade a borderline card may sit before it is not borderline. */
export const BORDERLINE_TOLERANCE = 0.1;

/**
 * How close to a card edge a bounding box must be to count as edge wear.
 *
 * Eight percent of a card is about 7mm, which is generous enough for a box
 * drawn around edge wear that stops just short of the edge.
 */
export const EDGE_PROXIMITY = 0.08;

/**
 * How far the measured severity and the model's own severity may differ
 * before the measurement is thrown away.
 *
 * A box drawn on a whole-card shot is a coarse guess about extent, and the
 * severity bands punish a guess that is too generous. One band of difference
 * is normal noise; more than that means the box cannot be trusted.
 */
export const MEASUREMENT_AGREEMENT = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CardGeometry {
  /** Physical card width in millimetres. */
  widthMm: number;
  /** Physical card height in millimetres. */
  heightMm: number;
  /** Where the card sits inside the photo, normalised to 0..1. */
  rect: Rect;
}

export const DEFAULT_CARD_GEOMETRY: CardGeometry = {
  widthMm: CARD_SIZES.standard.widthMm,
  heightMm: CARD_SIZES.standard.heightMm,
  rect: { x: 0, y: 0, w: 1, h: 1 },
};

/** Scale factors from a normalised card coordinate to millimetres. */
export function mmScale(geometry: CardGeometry): { x: number; y: number } {
  return {
    x: geometry.widthMm / Math.max(geometry.rect.w, 1e-6),
    y: geometry.heightMm / Math.max(geometry.rect.h, 1e-6),
  };
}

/**
 * The card edge a bounding box is nearest to, or null when it is nowhere near
 * one. The tolerance is generous: a box drawn around edge wear stops just
 * short of the edge rather than reaching it.
 */
function nearestEdge(bbox: Rect): "top" | "bottom" | "left" | "right" | null {
  const distances = [
    { edge: "top" as const, distance: bbox.y },
    { edge: "bottom" as const, distance: 1 - (bbox.y + bbox.h) },
    { edge: "left" as const, distance: bbox.x },
    { edge: "right" as const, distance: 1 - (bbox.x + bbox.w) },
  ];
  const nearest = distances.reduce((best, entry) =>
    entry.distance < best.distance ? entry : best
  );
  return nearest.distance <= EDGE_PROXIMITY ? nearest.edge : null;
}

/**
 * The millimetre measurement of a defect.
 *
 * `bbox` is normalised to the *card* rectangle, not to the photo, so the model
 * can describe a defect by where it sits on the card. For an edge imperfection
 * the length is measured along whichever card edge the defect is nearest to.
 *
 * `linear` is reported alongside the measurement because a long thin
 * indentation is measured by length rather than by area, and the two use
 * different severity bands.
 */
export interface ImperfectionMeasurement {
  /** Millimetres for length/lift, square millimetres for area. */
  measure: number;
  /** True when the measurement is a length that should use the linear bands. */
  linear: boolean;
}

export function measureImperfection(
  type: ImperfectionType,
  bbox: Rect,
  geometry: CardGeometry = DEFAULT_CARD_GEOMETRY,
): ImperfectionMeasurement | undefined {
  const rule = RULES[type];
  if (rule.measure === "none") return undefined;
  const scale = mmScale(geometry);
  const w = Math.max(0, bbox.w) * scale.x;
  const h = Math.max(0, bbox.h) * scale.y;

  if (rule.measure === "area") {
    // A long thin mark is an indentation measured by length, not by area.
    if (type === "Indentation" && Math.min(w, h) > 0) {
      const long = Math.max(w, h);
      const short = Math.min(w, h);
      if (long / short > 4) return { measure: long, linear: true };
    }
    return { measure: w * h, linear: false };
  }

  if (type === "Edgewear") {
    // The length runs along the card edge the defect is nearest to. A box drawn
    // around edge wear stops just short of the edge, so the nearest edge is
    // used rather than the edge the box literally touches.
    const nearest = nearestEdge(bbox);
    if (nearest === "top" || nearest === "bottom") return { measure: w, linear: false };
    if (nearest === "left" || nearest === "right") return { measure: h, linear: false };
    return { measure: Math.max(w, h), linear: false };
  }

  return { measure: Math.max(w, h), linear: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Severity and grading
// ─────────────────────────────────────────────────────────────────────────────

/** The severity band a measurement falls into. */
export function severityForMeasure(bands: SeverityBand[], measure: number): Severity {
  for (const band of bands) {
    if (measure <= band.max) return band.severity;
  }
  return bands[bands.length - 1].severity;
}

/** The severity band a measurement sits closest to, for "which side of the line" checks. */
export function nearestBandBoundary(
  bands: SeverityBand[],
  measure: number,
): { severity: Severity; boundary: number; distance: number } {
  let best = { severity: bands[0].severity, boundary: bands[0].max, distance: Infinity };
  for (const band of bands) {
    const distance = Math.abs(measure - band.max);
    if (distance < best.distance) {
      best = { severity: band.severity, boundary: band.max, distance };
    }
  }
  return best;
}

/** Rank of a grade, best (0) to worst (4). */
export function conditionRank(grade: ConditionGrade): number {
  return CONDITION_GRADES.indexOf(grade);
}

/** Rank of a severity, best (0) to worst (3). */
export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

/** The worse of two grades. */
export function worseGrade(a: ConditionGrade, b: ConditionGrade): ConditionGrade {
  return conditionRank(a) >= conditionRank(b) ? a : b;
}

/** The grade one step worse. */
export function nextWorse(grade: ConditionGrade): ConditionGrade | undefined {
  const index = CONDITION_GRADES.indexOf(grade);
  return index >= 0 && index < CONDITION_GRADES.length - 1 ? CONDITION_GRADES[index + 1] : undefined;
}

/** The grade one step better. */
export function nextBetter(grade: ConditionGrade): ConditionGrade | undefined {
  const index = CONDITION_GRADES.indexOf(grade);
  return index > 0 ? CONDITION_GRADES[index - 1] : undefined;
}

/** The best condition whose points cap the total fits under. */
export function pointsToGrade(points: number): ConditionGrade {
  for (const grade of CONDITION_GRADES) {
    if (grade === "DMG") break;
    if (points <= CONDITION_POINTS_CAP[grade]) return grade;
  }
  return "DMG";
}

/**
 * The best condition that still permits an imperfection of this severity and
 * measurement. Returns "DMG" when no condition but Damaged allows it.
 */
export function allowanceFloor(
  rule: ImperfectionRule,
  severity: Severity,
  measure: number | undefined,
  linear = false,
): ConditionGrade {
  const table = linear && rule.linear ? rule.linear.allowances : rule.allowances;
  for (const grade of CONDITION_GRADES) {
    const allowance = table[grade];
    if (!allowance || allowance.severity === null) continue;
    if (severityRank(allowance.severity) < severityRank(severity)) continue;
    if (measure !== undefined && measure > allowance.max) continue;
    return grade;
  }
  return "DMG";
}

// ─────────────────────────────────────────────────────────────────────────────
// Tally
// ─────────────────────────────────────────────────────────────────────────────

export interface TallyObservation {
  type: ImperfectionType;
  side?: "front" | "back";
  /** Where the imperfection is on the card, normalised to the card rectangle. */
  bbox?: Rect;
  /** Millimetres for length/lift, square millimetres for area. */
  measure?: number;
  /** The severity as reported, used when there is no usable measurement. */
  severity?: Severity;
  /** How many separate instances this covers. */
  instances?: number;
  /** The measurement is a length and should use the linear bands (indents only). */
  linear?: boolean;
  /** The imperfection compromises structure, playability or authentication. */
  integrity?: boolean;
  /** A bend that has creased the card. */
  crease?: boolean;
  /** 0..1 confidence in the observation. */
  confidence?: number;
  note?: string;
  source?: "model" | "manual";
}

export interface TallyImperfection {
  type: ImperfectionType;
  side?: "front" | "back";
  /** Where the imperfection is on the card, normalised to the card rectangle. */
  bbox?: Rect;
  severity: Severity;
  points: number;
  /** The best condition at which this imperfection would still be acceptable. */
  floor: ConditionGrade;
  /** The measurement the severity was derived from, when there was one. */
  measure?: number;
  /** True when the severity came from a measurement rather than a reported label. */
  measured: boolean;
  /** True when the measurement sits close enough to a band edge to be worth a second look. */
  nearBoundary: boolean;
  instances: number;
  confidence?: number;
  note?: string;
  source?: "model" | "manual";
}

export interface TallyFlags {
  damage: boolean;
  integrityDefect: boolean;
  crease: boolean;
  offCenter: boolean;
  curling: boolean;
}

export interface TallyResult {
  /** The grade the card qualifies for. This is the grade to list it at. */
  condition: ConditionGrade;
  /** The display label, including the borderline modifier. */
  label: string;
  /** The other way of reading a borderline card, e.g. "MP+" for an "LP-" card. */
  alternateLabel?: string;
  /** True when the card sits exactly on a condition boundary. */
  borderline: boolean;
  /** Total TCGplayer points. */
  points: number;
  /** The points cap of the resulting condition. */
  pointsCap: number;
  /** The condition the points alone would give. */
  pointsGrade: ConditionGrade;
  /** The condition the per-type allowances alone would give. */
  allowanceGrade: ConditionGrade;
  /** Every imperfection that was counted. */
  imperfections: TallyImperfection[];
  /** Imperfections worth a second look before the card is listed. */
  uncertain: TallyImperfection[];
  flags: TallyFlags;
  notes: string[];
}

/**
 * Turn observations into a condition.
 *
 * The condition is the worst of the points grade and the allowance grade, with
 * the hard rules (Damage, integrity defects, creases, curling) applied on top.
 */
export function tally(observations: TallyObservation[]): TallyResult {
  const counted: TallyImperfection[] = [];
  const uncertain: TallyImperfection[] = [];
  const notes: string[] = [];
  const flags: TallyFlags = {
    damage: false,
    integrityDefect: false,
    crease: false,
    offCenter: false,
    curling: false,
  };

  let points = 0;
  let allowanceGrade: ConditionGrade = "NM";

  for (const observation of observations) {
    const rule = RULES[observation.type];
    if (!rule) continue;

    const hasMeasure =
      typeof observation.measure === "number" && Number.isFinite(observation.measure);
    const linear = observation.linear === true && Boolean(rule.linear);
    const bands = linear && rule.linear ? rule.linear.bands : rule.bands;

    let severity: Severity | undefined;
    if (hasMeasure) {
      severity = severityForMeasure(bands, observation.measure as number);
    } else if (observation.severity) {
      severity = observation.severity;
    }
    if (!severity) continue;

    const instances = Math.max(1, Math.round(observation.instances ?? 1));
    const instancePoints = SEVERITY_POINTS[severity] * instances;
    points += instancePoints;

    const floor = allowanceFloor(
      rule,
      severity,
      hasMeasure ? (observation.measure as number) : undefined,
      linear,
    );
    allowanceGrade = worseGrade(allowanceGrade, floor);

    let nearBoundary = false;
    if (hasMeasure) {
      const nearest = nearestBandBoundary(bands, observation.measure as number);
      const span = nearest.boundary > 0 ? nearest.boundary : 1;
      nearBoundary = nearest.distance / span <= BORDERLINE_TOLERANCE;
    }

    const entry: TallyImperfection = {
      type: observation.type,
      side: observation.side,
      bbox: observation.bbox,
      severity,
      points: instancePoints,
      floor,
      measure: hasMeasure ? observation.measure : undefined,
      measured: hasMeasure,
      nearBoundary,
      instances,
      confidence: observation.confidence,
      note: observation.note,
      source: observation.source,
    };
    counted.push(entry);
    if (nearBoundary || (observation.confidence !== undefined && observation.confidence < 0.5)) {
      uncertain.push(entry);
    }
  }

  const pointsGrade = pointsToGrade(points);
  let condition = worseGrade(pointsGrade, allowanceGrade);

  // Hard rules.
  for (const entry of counted) {
    if (entry.type === "Damage") flags.damage = true;
    if (entry.type === "Curling") flags.curling = true;
  }
  for (const observation of observations) {
    if (observation.type === "Damage") flags.damage = true;
    if (observation.integrity) flags.integrityDefect = true;
    if (observation.crease) flags.crease = true;
  }
  if (flags.damage || flags.integrityDefect) {
    condition = "DMG";
  }
  if (flags.crease) {
    // A crease drops the card to Moderately Played at best.
    condition = worseGrade(condition, "MP");
  }
  if (flags.curling) {
    const curl = counted.find((entry) => entry.type === "Curling");
    if (curl && curl.severity === "Major") condition = "DMG";
  }

  // A borderline card sits exactly on its points cap: one more Slight imperfection
  // would push it down a grade.
  const cap = pointsCap(condition);
  const borderline = condition !== "DMG" && points >= cap;

  const label = borderline ? `${condition}-` : condition;
  const worse = nextWorse(condition);
  const alternateLabel = borderline
    ? worse === "DMG"
      ? "DMG"
      : `${worse}+`
    : undefined;

  if (flags.damage) notes.push("Damage is present — the card is Damaged.");
  if (flags.integrityDefect) {
    notes.push(
      "A defect compromises the card's integrity, playability or authentication — Damaged, but listable as a Listing with Photo at the condition it would otherwise qualify for.",
    );
  }
  if (flags.crease) notes.push("A crease drops the card to Moderately Played at best.");
  if (flags.offCenter) {
    notes.push(
      "Centering is worse than 70/30 — list the card as a Listing with Photo at the condition it would qualify for without the shifting.",
    );
  }
  if (borderline) {
    notes.push(
      `The card used every point ${condition} allows (${points} of ${cap}). Confirm it by eye before listing it.`,
    );
  }

  return {
    condition,
    label,
    alternateLabel,
    borderline,
    points,
    pointsCap: cap,
    pointsGrade,
    allowanceGrade,
    imperfections: counted,
    uncertain,
    flags,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Observations from the model
// ─────────────────────────────────────────────────────────────────────────────

/** One image the model was shown, and the part of the card it shows. */
export interface PreparedPhotoImage {
  /** Identifies the image in the model's answer. */
  label: string;
  /** The part of the card this image covers, in card coordinates. */
  cardRegion: Rect;
  /**
   * Whether a bounding box on this image can be trusted for measurement.
   *
   * A close-up of a corner or an edge shows the model the defect at
   * magnification, so the box it draws is tight enough to measure. A whole-card
   * shot is context: the box there is a coarse guess about extent, and the
   * severity bands punish a generous guess. Whole-card shots are therefore
   * judged on the model's own severity.
   */
  measurable?: boolean;
}

/** What the model reported about one imperfection. */
export interface ModelObservation {
  /** The label of the image the imperfection was seen in. */
  image: string;
  type: string;
  side?: "front" | "back";
  /** [x, y, w, h] as a fraction of that image. */
  bbox?: number[];
  severity?: string;
  confidence?: number;
  note?: string;
  integrity?: boolean;
}

const KNOWN_TYPES: string[] = [
  "Edgewear",
  "Scuffing",
  "Scratch",
  "Surface Wear",
  "Grime",
  "Indentation",
  "Bend",
  "Curling",
  "Fault",
  "Defect",
  "Damage",
];

const KNOWN_SEVERITIES: string[] = ["Slight", "Minor", "Moderate", "Major"];

function isKnownType(value: string): value is ImperfectionType {
  return (KNOWN_TYPES as string[]).includes(value);
}

function isKnownSeverity(value: string): value is Severity {
  return (KNOWN_SEVERITIES as string[]).includes(value);
}

/** Move a box from an image's own coordinates into the card's coordinates. */
function toCardRegion(bbox: number[], region: Rect): Rect {
  const [x, y, w, h] = bbox;
  return {
    x: region.x + x * region.w,
    y: region.y + y * region.h,
    w: w * region.w,
    h: h * region.h,
  };
}

function overlapArea(a: Rect, b: Rect): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

/**
 * The same imperfection often shows up in more than one photo — a worn corner
 * appears in the full shot and again in the corner close-up. Counting it twice
 * would double the points, so near-identical boxes are merged.
 */
function dedupeObservations(
  entries: { type: ImperfectionType; side?: string; cardRect: Rect; observation: TallyObservation }[]
): TallyObservation[] {
  const kept: typeof entries = [];
  for (const entry of entries) {
    const duplicate = kept.find((other) => {
      if (other.type !== entry.type) return false;
      if ((other.side ?? "front") !== (entry.side ?? "front")) return false;
      const minArea = Math.min(
        other.cardRect.w * other.cardRect.h,
        entry.cardRect.w * entry.cardRect.h
      );
      if (!minArea) return false;
      return overlapArea(other.cardRect, entry.cardRect) > 0.4 * minArea;
    });
    if (!duplicate) kept.push(entry);
  }
  return kept.map((entry) => entry.observation);
}

/**
 * Turn what the model saw into measurements the rulebook can use.
 *
 * The model reports a bounding box in the image it was looking at and a
 * severity. The box is what we trust: it is converted to millimetres against
 * the card and the severity is derived from the published bands. The model's
 * own severity is only used when there is no usable box.
 */
export function measureObservations(
  observations: ModelObservation[],
  images: PreparedPhotoImage[]
): TallyObservation[] {
  const byLabel = new Map(images.map((image) => [image.label, image]));
  const entries: {
    type: ImperfectionType;
    side?: string;
    cardRect: Rect;
    observation: TallyObservation;
  }[] = [];

  for (const raw of observations) {
    if (!isKnownType(raw.type)) continue;
    const image = byLabel.get(raw.image);
    const bbox =
      raw.bbox && raw.bbox.length === 4 && raw.bbox.every((v) => Number.isFinite(v))
        ? raw.bbox
        : undefined;

    let cardRect: Rect | undefined;
    let mapped: Rect | undefined;
    let measure: number | undefined;
    let linear = false;
    const label = raw.severity && isKnownSeverity(raw.severity) ? raw.severity : undefined;
    if (image && bbox) {
      // Keep the location even when the box is too coarse to measure: the app
      // shows it to the collector, it just does not derive a size from it.
      mapped = toCardRegion(bbox, image.cardRegion);
    }
    if (mapped && image && image.measurable !== false) {
      cardRect = mapped;
      const measurement = measureImperfection(raw.type, cardRect, DEFAULT_CARD_GEOMETRY);
      if (measurement) {
        const bands =
          raw.type === "Indentation" && measurement.linear && RULES.Indentation.linear
            ? RULES.Indentation.linear.bands
            : RULES[raw.type].bands;
        const measured = severityForMeasure(bands, measurement.measure);
        // A measurement that contradicts the model by more than one band means
        // the box is wrong, not that the defect is worse than it looks.
        if (!label || Math.abs(severityRank(measured) - severityRank(label)) <= MEASUREMENT_AGREEMENT) {
          measure = measurement.measure;
          linear = measurement.linear;
        }
      }
    }

    entries.push({
      type: raw.type,
      side: raw.side,
      cardRect: cardRect ?? { x: 0, y: 0, w: 0, h: 0 },
      observation: {
        type: raw.type,
        side: raw.side,
        bbox: mapped,
        measure,
        linear,
        severity: label,
        confidence: raw.confidence,
        note: raw.note,
        integrity: raw.integrity === true,
        source: "model",
      },
    });
  }

  return dedupeObservations(entries);
}

/** Grade the photos: measure what was seen, then apply the rulebook. */
export function gradeFromObservations(
  observations: ModelObservation[],
  images: PreparedPhotoImage[]
): TallyResult {
  return tally(measureObservations(observations, images));
}

export interface ChecklistAnswer {
  type: ImperfectionType;
  severity: Severity | null;
  instances?: number;
  note?: string;
}

/**
 * Grade from what the vendor saw themselves.
 *
 * The same rulebook, the same tally — this is the offline path and the one a
 * vendor uses when they disagree with the estimate.
 */
export function gradeFromChecklist(answers: ChecklistAnswer[]): TallyResult {
  const observations: TallyObservation[] = [];
  for (const answer of answers) {
    if (!answer.severity) continue;
    observations.push({
      type: answer.type,
      severity: answer.severity,
      instances: answer.instances,
      note: answer.note,
      source: "manual",
    });
  }
  return tally(observations);
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation
// ─────────────────────────────────────────────────────────────────────────────

/** A human-readable size hint for one severity band. */
export function describeBand(
  type: ImperfectionType,
  severity: Severity,
  linear = false,
): string {
  const rule = RULES[type];
  const bands = linear && rule.linear ? rule.linear.bands : rule.bands;
  const band = bands.find((entry) => entry.severity === severity);
  if (!band) return severity;
  const limit = band.max === Number.POSITIVE_INFINITY ? "no upper limit" : `${trim(band.max)}`;
  switch (rule.measure) {
    case "length":
      return `up to ${limit}mm`;
    case "lift":
      return `up to ${limit}mm of lift`;
    case "area":
      return `up to ${limit}mm²`;
    default:
      return severity;
  }
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

/** The checklist the offline manual grader walks through. */
export const CHECKLIST_OPTIONS: { severity: Severity | null; label: string }[] = [
  { severity: null, label: "None" },
  { severity: "Slight", label: "Slight" },
  { severity: "Minor", label: "Minor" },
  { severity: "Moderate", label: "Moderate" },
  { severity: "Major", label: "Major" },
];

/**
 * Render the rulebook as text for the model prompt and for the in-app
 * reference. Infinity is written out rather than serialised.
 */
export function renderRulesText(): string {
  const lines: string[] = [];
  lines.push("CONDITION CAPS (total TCGplayer points a card may carry)");
  for (const summary of CONDITION_SUMMARY) {
    const cap = summary.id === "DMG" ? "over 24" : String(summary.points);
    const notAllowed = summary.notAllowed.length ? ` — not allowed: ${summary.notAllowed.join(", ")}` : "";
    lines.push(`  ${summary.id} (${summary.label}): up to ${cap} points${notAllowed}`);
  }

  lines.push("");
  lines.push("IMPERFECTION SEVERITY POINTS");
  for (const severity of SEVERITIES) {
    lines.push(`  ${severity}: ${SEVERITY_POINTS[severity]} point${SEVERITY_POINTS[severity] === 1 ? "" : "s"}`);
  }

  lines.push("");
  lines.push("IMPERFECTION TYPES, SEVERITY BANDS AND WHAT EACH CONDITION ALLOWS");
  for (const type of RULE_ORDER) {
    const rule = RULES[type];
    lines.push(`  ${type} (measured by ${rule.measure === "none" ? "presence" : rule.measure})`);
    for (const band of rule.bands) {
      lines.push(`    ${band.severity}: ${describeBand(type, band.severity)}`);
    }
    const allowanceText = CONDITION_GRADES.map((grade) => {
      const allowance = rule.allowances[grade];
      if (!allowance || allowance.severity === null) return `${grade}: not allowed`;
      const limit = allowance.max === Number.POSITIVE_INFINITY ? "no upper limit" : trim(allowance.max);
      return `${grade}: up to ${allowance.severity}, ${limit}${rule.measure === "area" ? "mm²" : rule.measure === "none" ? "" : "mm"}`;
    });
    lines.push(`    allowed by condition — ${allowanceText.join("; ")}`);
    if (rule.linear) {
      lines.push(
        `    linear indents (measured by length) — ${CONDITION_GRADES.map((grade) => {
          const allowance = rule.linear!.allowances[grade];
          if (!allowance || allowance.severity === null) return `${grade}: not allowed`;
          return `${grade}: up to ${allowance.severity}, ${trim(allowance.max)}mm`;
        }).join("; ")}`,
      );
    }
    lines.push(`    ${rule.note}`);
  }

  lines.push("");
  lines.push("RULES THAT APPLY EVERYWHERE");
  for (const rule of SPECIAL_RULES) lines.push(`  - ${rule}`);

  lines.push("");
  lines.push("POKEMON SPECIFIC NOTES");
  for (const note of POKEMON_NOTES) lines.push(`  - ${note}`);

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Model contract
// ─────────────────────────────────────────────────────────────────────────────

export interface ConditioningPromptContext {
  card?: {
    name?: string;
    setName?: string;
    number?: string;
    holo?: boolean;
    printingEra?: string;
    rarity?: string;
  };
  /** Labels of the photos being sent, in order. */
  photoLabels?: string[];
  /** Something the collector noticed that the photos cannot show. */
  note?: string;
}

/** The JSON the vision model is asked to return. */
export const OBSERVATION_SCHEMA = `{
  "observations": [
    {
      "image": 1,
      "type": "Edgewear | Scuffing | Scratch | Surface Wear | Grime | Indentation | Bend | Curling | Fault | Defect | Damage",
      "side": "front | back",
      "bbox": [0.0, 0.0, 0.0, 0.0],
      "severity": "Slight | Minor | Moderate | Major",
      "confidence": 0.0,
      "note": "what you can actually see"
    }
  ],
  "photoQuality": { "blurred": [], "glare": [], "unusable": [] },
  "notes": []
}`;

/** Build the prompt that asks the model for observations only. */
export function buildConditioningPrompt(context: ConditioningPromptContext = {}): string {
  const card = context.card;
  const cardBits: string[] = [];
  if (card?.name) cardBits.push(`name "${card.name}"`);
  if (card?.setName) cardBits.push(`set "${card.setName}"`);
  if (card?.number) cardBits.push(`number ${card.number}`);
  if (card?.rarity) cardBits.push(`rarity "${card.rarity}"`);
  if (card?.printingEra) cardBits.push(`printing era ${card.printingEra}`);
  if (card?.holo) cardBits.push("holo/foil card");

  const labels = context.photoLabels?.length
    ? context.photoLabels.map((label, index) => `  image ${index + 1}: ${label}`).join("\n")
    : "  (no photos)";

  const labelText = context.photoLabels?.length
    ? context.photoLabels.map((label, index) => `  ${index + 1} = ${label}`).join("\n")
    : "  (no photos)";

  return `You are a TCGplayer card conditioning technician. Examine the photos of a single trading card and report ONLY the imperfections you can actually see. You do NOT decide the condition - a rulebook does that. Report what you see, and where.

CARD UNDER EXAMINATION
${cardBits.length ? cardBits.join(", ") : "(unknown card)"}
${context.note ? `COLLECTOR NOTE\n${context.note}\n` : ""}

PHOTOS (in order)
${labels}

HOW TO MEASURE
The card is ${CARD_SIZES.standard.widthMm}mm wide and ${CARD_SIZES.standard.heightMm}mm tall. Use the card itself as your ruler.
Give every imperfection a bounding box as [x, y, w, h] in fractions of THE IMAGE IT IS IN: x and y are the top-left corner of the imperfection within that image, w and h are its width and height, all from 0 to 1. Do not use card coordinates - each image has its own frame, and the close-ups are cropped.
Judge the size of the imperfection against the card, not against the image. A mark that is 1/63 of the card's width is 1mm. An area 1/8 of the card's width by 1/8 of its height is about 8mm x 11mm, which is roughly 88mm². On a close-up, work out how much of the card the image covers before you judge the size.
Corner and edge close-ups are cropped, so for those images the box is relative to the crop - report where in that crop the imperfection sits.

WHAT TO REPORT
- Report an imperfection only when you can point to it. Do not describe a card as worn because it is old, holo, or has an unusual print run.
- A single pinpoint of white is Slight, not Minor. A short nick on the edge is Slight. Do not inflate a defect to describe it more vividly.
- Surface Wear is where the colour layer is gone and the pale cardstock shows through - that is different from Scuffing, which is a cloudy buffed patch that still has colour, and different from a Scratch, which is a thin line that has not removed anything.
- Edgewear is loss of colour or gloss along the very edge of the card. If the wear reaches more than about half a millimetre in from the edge, report it as Surface Wear instead.
- Grime is dirt or a smudge. Ink, marker, tape, food or liquid are Damage.
- A production error (blurred or doubled ink, a roller line, a cut that is not square, a missing holo stamp) is a Defect. Say so in the note, and set "integrity": true when it makes the card unplayable or unauthenticatable.
- Roller lines and fine scratches on modern Pokemon cards are common. Report what you see, but do not treat a normal print run as damage.
- If a photo is blurred, glared over or otherwise unreadable, put its label in photoQuality and do not guess about what is on it.
- Give a severity that matches the measurement you are reporting. If you are unsure between two severities, choose the lower one and lower the confidence.
- Judge the exact size of an imperfection from the close-up that shows it. On a whole-card shot, judge how bad it looks rather than how far it runs — the close-ups are where the size is measured.
- The same imperfection can appear in more than one image. Report it once, using the image where it is clearest.
- Say which image each imperfection is in, by its number below.

IMAGES
${labelText}

RULEBOOK
${renderRulesText()}

OUTPUT
Reply with JSON only, no prose and no code fences:
${OBSERVATION_SCHEMA}`;
}
