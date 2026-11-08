#!/usr/bin/env node
/**
 * Smoke test the live grading service.
 *
 * Sends one real card image to the deployed Worker, prints what came back and
 * what the app would make of it. This is the check to run after changing the
 * provider, the model, or the rulebook — the unit tests cannot tell you
 * whether the model can still see a defect.
 *
 *   node scripts/probe-conditioning.mjs
 *   node scripts/probe-conditioning.mjs --url http://localhost:8787
 *   node scripts/probe-conditioning.mjs --image path/to/card.jpg
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index > -1 && args[index + 1] ? args[index + 1] : fallback;
}

const url = (arg("--url", "https://pocket-condition.blogue-e68.workers.dev")).replace(/\/+$/, "");

async function cardImage() {
  const explicit = arg("--image", undefined);
  if (explicit) {
    const bytes = readFileSync(explicit);
    const ext = explicit.split(".").pop()?.toLowerCase();
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    return { dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, name: "the card" };
  }
  const catalogue = JSON.parse(
    readFileSync(
      resolve(repoRoot, "../PocketVaultTCG/src/data/cards.json"),
      "utf8"
    )
  ).cards;
  const card = catalogue.find((c) => c.holo && c.image);
  if (!card) throw new Error("No card artwork available for the probe.");
  const res = await fetch(card.image);
  if (!res.ok) throw new Error(`card artwork fetch failed ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    dataUrl: `data:image/webp;base64,${bytes.toString("base64")}`,
    name: `${card.name} (${card.setId} ${card.number})`,
  };
}

const rubricPath = resolve(repoRoot, "scripts/.cache/rubric-probe.mjs");
await build({
  entryPoints: [resolve(repoRoot, "conditioning/rubric.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  outfile: rubricPath,
  logLevel: "warning",
});
const { gradeFromObservations } = await import(`${pathToFileURL(rubricPath).href}?v=${Date.now()}`);

const image = await cardImage();
console.log(`card: ${image.name}`);
console.log(`service: ${url}\n`);

const res = await fetch(`${url}/v1/grade`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    card: { name: image.name },
    images: [{ label: "front of the card, the whole card", dataUrl: image.dataUrl }],
  }),
});
const payload = await res.json();
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${JSON.stringify(payload)}`);
  process.exit(1);
}

console.log(`provider: ${payload.provider ?? "?"}   model: ${payload.model}`);
console.log(`rubric: ${payload.rubricVersion}   usage: ${JSON.stringify(payload.usage)}`);
console.log(`observations: ${payload.observations.length}`);
for (const observation of payload.observations) {
  console.log(
    `  - ${observation.type} ${observation.severity} ` +
      `conf ${observation.confidence ?? "?"} bbox ${JSON.stringify(observation.bbox)}`,
  );
  if (observation.note) console.log(`      ${observation.note}`);
}
for (const note of payload.notes ?? []) console.log(`note: ${note}`);

// The Worker measures nothing: it has no idea how big the card was. This is
// the app's own tally, applied to what the model reported.
const result = gradeFromObservations(payload.observations ?? [], [
  {
    label: "front of the card, the whole card",
    cardRegion: { x: 0, y: 0, w: 1, h: 1 },
    measurable: false,
  },
]);
console.log(
  `\napp tally (whole-card shot, label only): ${result.condition}, ${result.points} points`,
);
