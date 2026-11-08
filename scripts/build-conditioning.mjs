import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** Build the Worker bundle the Cloudflare runtime executes. */
export async function buildWorker() {
  const outfile = resolve(root, "conditioning-worker/dist/worker.js");
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(root, "conditioning-worker/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile,
    logLevel: "warning",
  });
  return outfile;
}

/** Build the shared rulebook and its tests so the standalone checks can run them. */
export async function buildRubric(outfile) {
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(root, "conditioning/rubric.test.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    outfile,
    logLevel: "warning",
  });
  return outfile;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const target = process.argv[2] === "rubric" ? "rubric" : "worker";
  if (target === "rubric") {
    const out = await buildRubric(resolve(root, "scripts/.cache/rubric-check.mjs"));
    console.log("built", out);
  } else {
    const out = await buildWorker();
    console.log("built", out);
  }
}
