#!/usr/bin/env node
/**
 * Run the conditioning evaluation set through the grading service.
 *
 * Each case in `conditioning-eval/manifest.json` is a card with a grade a
 * vendor agreed on, plus the photos that card was graded from. The runner
 * sends the photos to the service, applies the rulebook to what comes back, and
 * reports how often the app agrees with the vendor — plus what it missed, what
 * it invented, and the reliability score the app would have shown.
 *
 *   node scripts/eval-conditioning.mjs                       # against the deployed service
 *   node scripts/eval-conditioning.mjs --url http://localhost:8787
 *   node scripts/eval-conditioning.mjs --case <id>          # one case
 *   node scripts/eval-conditioning.mjs --min-agreement 0.8  # fail below this
 *   node scripts/eval-conditioning.mjs --provider ollama --model gemma4:31b
 *   node scripts/eval-conditioning.mjs --matrix "deepseek:deepseek-flash,ollama:gemma4:31b"
 *
 * `--provider`, `--model` and `--matrix` need the service to be running with
 * `CONDITION_ALLOW_CALLER_KEY` set and a key for each provider, or a staging
 * Worker configured with `CONDITION_PROVIDER`/`CONDITION_MODEL`.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRubric } from "./build-conditioning.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index > -1 && args[index + 1] ? args[index + 1] : fallback;
}

const WORKER_URL = (
  arg("--url", process.env.CONDITION_WORKER_URL ?? "https://pocket-condition.blogue-e68.workers.dev")
).replace(/\/+$/, "");
const ONLY = arg("--case", undefined);
const MIN_AGREEMENT = Number(arg("--min-agreement", "0.8"));
const PROVIDER = arg("--provider", undefined);
const MODEL = arg("--model", undefined);
const MATRIX = arg("--matrix", undefined);

const manifestPath = join(repoRoot, "conditioning-eval", "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`missing ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const rubricPath = await buildRubric(resolve(repoRoot, "scripts/.cache/rubric-eval.mjs"));
const { gradeFromObservations, confidenceFromTally, CONDITION_GRADES } = await import(
  `${pathToFileURL(rubricPath).href}?v=${Date.now()}`
);

const candidates = MATRIX
  ? MATRIX.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [provider, ...rest] = entry.split(":");
        return { provider, model: rest.join(":") || undefined };
      })
  : [{ provider: PROVIDER, model: MODEL }];

function rank(grade) {
  return CONDITION_GRADES.indexOf(grade);
}

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Read the pixel size out of a JPEG header without decoding it. */
function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

function imageSize(buffer, path) {
  if (path.toLowerCase().endsWith(".png")) return pngSize(buffer);
  return jpegSize(buffer);
}

function photoId(label) {
  const text = String(label ?? "").toLowerCase();
  if (text.includes("back")) return "back";
  if (text.includes("raking") || text.includes("surface")) return "surface";
  return "front";
}

function countByType(items) {
  const counts = new Map();
  for (const item of items ?? []) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  return counts;
}

async function runCase(testCase, candidate) {
  const images = [];
  const descriptors = [];
  const evidencePhotos = [];
  for (const photo of testCase.photos ?? []) {
    const path = join(repoRoot, photo.file);
    if (!existsSync(path)) {
      return { id: testCase.id, error: `missing photo ${photo.file}` };
    }
    const bytes = readFileSync(path);
    const ext = path.split(".").pop()?.toLowerCase() ?? "jpg";
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    images.push({
      label: photo.label,
      dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
    });
    const region = photo.cardRegion ?? { x: 0, y: 0, w: 1, h: 1 };
    descriptors.push({
      label: photo.label,
      cardRegion: region,
      measurable: photo.measurable === true,
    });
    const size = imageSize(bytes, path);
    evidencePhotos.push({
      id: photoId(photo.label),
      width: size ? size.width / Math.max(0.01, region.w) : 0,
      height: size ? size.height / Math.max(0.01, region.h) : 0,
      // Node has no image decoder here, so sharpness, brightness and glare are
      // neutral. They are identical across candidates, so model comparisons are
      // unaffected; treat the absolute reliability as an upper bound.
      sharpness: 120,
      brightness: 140,
      glare: 0.02,
    });
  }

  const response = await fetch(`${WORKER_URL}/v1/grade`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      card: testCase.card,
      images,
      ...(candidate.provider ? { provider: candidate.provider } : {}),
      ...(candidate.model ? { model: candidate.model } : {}),
    }),
  });
  if (!response.ok) {
    return { id: testCase.id, error: `service returned HTTP ${response.status}` };
  }
  const payload = await response.json();
  const result = gradeFromObservations(payload.observations ?? [], descriptors);
  const confidence = confidenceFromTally(result, {
    photos: evidencePhotos,
    imagesSent: images.length,
    unusableImages: (payload.photoQuality?.unusable ?? []).length,
  });
  const expected = testCase.expected ?? {};

  const found = countByType(result.imperfections);
  const wanted = countByType(expected.imperfections);
  const missed = [...wanted.keys()].filter((type) => !found.has(type));
  const spurious = [...found.keys()].filter((type) => !wanted.has(type));

  return {
    id: testCase.id,
    expectedCondition: expected.condition,
    actualCondition: result.condition,
    provider: payload.provider ?? candidate.provider ?? "?",
    model: payload.model ?? candidate.model ?? "?",
    exact: expected.condition === result.condition,
    withinOne:
      expected.condition !== undefined &&
      Math.abs(rank(expected.condition) - rank(result.condition)) <= 1,
    expectedPoints: expected.points,
    actualPoints: result.points,
    confidence: confidence.score,
    confidenceBand: confidence.band,
    missed,
    spurious,
    borderline: result.borderline,
    contradictions: result.contradictions,
  };
}

const cases = (manifest.cases ?? []).filter((testCase) => !ONLY || testCase.id === ONLY);
if (!cases.length) {
  console.log("No evaluation cases yet.");
  console.log("Add them under conditioning-eval/ and list them in conditioning-eval/manifest.json.");
  process.exit(0);
}

const results = [];
for (const candidate of candidates) {
  const label = `${candidate.provider ?? "default"}${candidate.model ? `/${candidate.model}` : ""}`;
  console.log(`\n${label}`);
  for (const testCase of cases) {
    process.stdout.write(`• ${testCase.id} … `);
    try {
      const result = await runCase(testCase, candidate);
      results.push({ ...result, candidate: label });
      if (result.error) {
        console.log(`error — ${result.error}`);
        continue;
      }
      console.log(
        `${result.exact ? "match" : result.withinOne ? "within one" : "MISMATCH"} ` +
          `(expected ${result.expectedCondition}, got ${result.actualCondition}, ` +
          `${result.actualPoints} pts, ${result.confidence}% reliable` +
          `${result.missed.length ? `, missed ${result.missed.join(", ")}` : ""}` +
          `${result.spurious.length ? `, extra ${result.spurious.join(", ")}` : ""})`
      );
    } catch (error) {
      results.push({ id: testCase.id, candidate: label, error: String(error?.message ?? error) });
      console.log(`error — ${error?.message ?? error}`);
    }
  }
}

const summarise = (rows) => {
  const graded = rows.filter((row) => !row.error);
  const exact = graded.filter((row) => row.exact).length;
  const withinOne = graded.filter((row) => row.withinOne).length;
  const confidence = graded.length
    ? graded.reduce((sum, row) => sum + (row.confidence ?? 0), 0) / graded.length
    : 0;
  const buckets = [
    { label: "80-100", min: 80, rows: graded.filter((row) => row.confidence >= 80) },
    { label: "60-79", min: 60, rows: graded.filter((row) => row.confidence >= 60 && row.confidence < 80) },
    { label: "<60", min: 0, rows: graded.filter((row) => row.confidence < 60) },
  ].map((bucket) => ({
    bucket: bucket.label,
    cases: bucket.rows.length,
    exact: bucket.rows.filter((row) => row.exact).length,
  }));
  return {
    cases: graded.length,
    exact,
    withinOne,
    agreement: graded.length ? exact / graded.length : 0,
    meanConfidence: Math.round(confidence),
    buckets,
  };
};

const byCandidate = candidates.map((candidate) => {
  const label = `${candidate.provider ?? "default"}${candidate.model ? `/${candidate.model}` : ""}`;
  return { candidate: label, ...summarise(results.filter((row) => row.candidate === label)) };
});

console.log("");
for (const summary of byCandidate) {
  console.log(
    `${summary.candidate}: ${summary.exact}/${summary.cases} exact · ` +
      `${summary.withinOne}/${summary.cases} within one grade · ` +
      `agreement ${(summary.agreement * 100).toFixed(1)}% · mean reliability ${summary.meanConfidence}%`
  );
  for (const bucket of summary.buckets) {
    if (bucket.cases) {
      console.log(
        `  ${bucket.bucket} reliability: ${bucket.exact}/${bucket.cases} exact ` +
          `(${Math.round((bucket.exact / bucket.cases) * 100)}%)`
      );
    }
  }
}

const perType = new Map();
for (const row of results.filter((entry) => !entry.error)) {
  for (const type of row.missed) {
    const entry = perType.get(type) ?? { missed: 0, spurious: 0 };
    entry.missed += 1;
    perType.set(type, entry);
  }
  for (const type of row.spurious) {
    const entry = perType.get(type) ?? { missed: 0, spurious: 0 };
    entry.spurious += 1;
    perType.set(type, entry);
  }
}

const reportPath = join(repoRoot, "conditioning-eval", "report.json");
const markdownPath = join(repoRoot, "conditioning-eval", "report.md");
const generatedAt = new Date().toISOString();
writeFileSync(
  reportPath,
  JSON.stringify(
    { generatedAt, url: WORKER_URL, candidates: byCandidate, perType: Object.fromEntries(perType), results },
    null,
    2
  )
);

const lines = [
  "# Conditioning evaluation",
  "",
  `Generated: ${generatedAt}`,
  `Service: ${WORKER_URL}`,
  "",
  "| Model | Exact | Within one | Agreement | Mean reliability |",
  "| --- | --- | --- | --- | --- |",
  ...byCandidate.map(
    (summary) =>
      `| ${summary.candidate} | ${summary.exact}/${summary.cases} | ${summary.withinOne}/${summary.cases} | ${(summary.agreement * 100).toFixed(1)}% | ${summary.meanConfidence}% |`
  ),
  "",
  "## Calibration",
  "",
  "| Model | Reliability bucket | Cases | Exact |",
  "| --- | --- | --- | --- |",
  ...byCandidate.flatMap((summary) =>
    summary.buckets.map(
      (bucket) => `| ${summary.candidate} | ${bucket.bucket} | ${bucket.cases} | ${bucket.exact} |`
    )
  ),
  "",
  "## Missed and spurious types",
  "",
  "| Type | Missed | Spurious |",
  "| --- | --- | --- |",
  ...[...perType.entries()].map(
    ([type, counts]) => `| ${type} | ${counts.missed} | ${counts.spurious} |`
  ),
  "",
  "Node has no image decoder here, so every case uses neutral sharpness/brightness/glare in the",
  "reliability score. Those terms are identical across models; treat the absolute number as an",
  "upper bound and compare models on the same photos.",
];
writeFileSync(markdownPath, `${lines.join("\n")}\n`);
console.log(`\nwrote ${reportPath}`);
console.log(`wrote ${markdownPath}`);

const worst = Math.min(...byCandidate.map((summary) => summary.agreement));
if (byCandidate.some((summary) => summary.cases) && worst < MIN_AGREEMENT) {
  console.error("\nagreement is below the minimum — the rulebook or the prompt needs work.");
  process.exit(1);
}
