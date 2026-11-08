#!/usr/bin/env node
/**
 * Run the conditioning evaluation set through the grading service.
 *
 * Each case in `conditioning-eval/manifest.json` is a card with a grade a
 * vendor agreed on, plus the photos that card was graded from. The runner
 * sends the photos to the service, applies the rulebook to what comes back,
 * and reports how often the app agrees with the vendor.
 *
 *   node scripts/eval-conditioning.mjs                       # against the deployed service
 *   node scripts/eval-conditioning.mjs --url http://localhost:8787
 *   node scripts/eval-conditioning.mjs --case <id>          # one case
 *   node scripts/eval-conditioning.mjs --min-agreement 0.8  # fail below this
 *   node scripts/eval-conditioning.mjs --provider ollama --model gemma4:31b
 *
 * `--provider` and `--model` need the service to be running with
 * `CONDITION_ALLOW_CALLER_KEY` set, and a key in `OLLAMA_API_KEY` or
 * `DEEPSEEK_KEY` on the service. They are for trying a model against the set
 * without a redeploy.
 */
import { readFileSync, existsSync } from "node:fs";
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

const manifestPath = join(repoRoot, "conditioning-eval", "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`missing ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const rubricPath = await buildRubric(resolve(repoRoot, "scripts/.cache/rubric-eval.mjs"));
const { gradeFromObservations, CONDITION_GRADES } = await import(
  `${pathToFileURL(rubricPath).href}?v=${Date.now()}`
);

function rank(grade) {
  return CONDITION_GRADES.indexOf(grade);
}

async function runCase(testCase) {
  const images = [];
  const descriptors = [];
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
    // The part of the card the image covers, so the app's tally can map a
    // bounding box back onto the card. Whole-card shots cover the whole card;
    // a close-up covers the region it was cut from.
    descriptors.push({
      label: photo.label,
      cardRegion: photo.cardRegion ?? { x: 0, y: 0, w: 1, h: 1 },
      measurable: photo.measurable === true,
    });
  }

  const response = await fetch(`${WORKER_URL}/v1/grade`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      card: testCase.card,
      images,
      ...(PROVIDER ? { provider: PROVIDER } : {}),
      ...(MODEL ? { model: MODEL } : {}),
    }),
  });
  if (!response.ok) {
    return { id: testCase.id, error: `service returned HTTP ${response.status}` };
  }
  const payload = await response.json();
  const result = gradeFromObservations(payload.observations ?? [], descriptors);
  const expected = testCase.expected ?? {};

  const found = new Set(result.imperfections.map((entry) => entry.type));
  const wanted = new Set((expected.imperfections ?? []).map((entry) => entry.type));
  const missed = [...wanted].filter((type) => !found.has(type));
  const spurious = [...found].filter((type) => !wanted.has(type));

  return {
    id: testCase.id,
    expectedCondition: expected.condition,
    actualCondition: result.condition,
    provider: payload.provider ?? "?",
    model: payload.model ?? "?",
    exact: expected.condition === result.condition,
    withinOne:
      expected.condition !== undefined &&
      Math.abs(rank(expected.condition) - rank(result.condition)) <= 1,
    expectedPoints: expected.points,
    actualPoints: result.points,
    missed,
    spurious,
    borderline: result.borderline,
  };
}

const cases = (manifest.cases ?? []).filter((testCase) => !ONLY || testCase.id === ONLY);
if (!cases.length) {
  console.log("No evaluation cases yet.");
  console.log("Add them under conditioning-eval/ and list them in conditioning-eval/manifest.json.");
  process.exit(0);
}

const results = [];
for (const testCase of cases) {
  process.stdout.write(`• ${testCase.id} … `);
  try {
    const result = await runCase(testCase);
    results.push(result);
    if (result.error) {
      console.log(`error — ${result.error}`);
      continue;
    }
    console.log(
      `${result.exact ? "match" : result.withinOne ? "within one" : "MISMATCH"} ` +
        `(expected ${result.expectedCondition}, got ${result.actualCondition}, ` +
        `${result.actualPoints} pts` +
        `${result.missed.length ? `, missed ${result.missed.join(", ")}` : ""}` +
        `${result.spurious.length ? `, extra ${result.spurious.join(", ")}` : ""}) ` +
        `[${result.provider}/${result.model}]`,
    );
  } catch (error) {
    results.push({ id: testCase.id, error: String(error?.message ?? error) });
    console.log(`error — ${error?.message ?? error}`);
  }
}

const graded = results.filter((result) => !result.error);
const exact = graded.filter((result) => result.exact).length;
const withinOne = graded.filter((result) => result.withinOne).length;
const agreement = graded.length ? exact / graded.length : 0;

console.log("");
console.log(`${exact}/${graded.length} exact · ${withinOne}/${graded.length} within one grade`);
console.log(`agreement ${(agreement * 100).toFixed(1)}% (minimum ${(MIN_AGREEMENT * 100).toFixed(0)}%)`);

if (graded.length && agreement < MIN_AGREEMENT) {
  console.error("\nagreement is below the minimum — the rulebook or the prompt needs work.");
  process.exit(1);
}
