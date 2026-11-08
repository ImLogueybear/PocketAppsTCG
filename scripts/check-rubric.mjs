import { buildRubric } from "./build-conditioning.mjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = await buildRubric(resolve(here, ".cache/rubric-check.mjs"));
const { runRubricTests } = await import(pathToFileURL(out).href);
const results = runRubricTests();
let failures = 0;
for (const result of results) {
  if (!result.ok) failures += 1;
  console.log(`${result.ok ? "ok  " : "FAIL"} ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
}
console.log(failures ? `\n${failures} of ${results.length} rubric checks failed` : `\nall ${results.length} rubric checks passed`);
process.exit(failures ? 1 : 0);
