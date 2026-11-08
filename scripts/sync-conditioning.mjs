#!/usr/bin/env node
/**
 * Sync the shared conditioning rulebook into the two apps.
 *
 * `conditioning/rubric.ts` and `conditioning/rubric.test.ts` are the single
 * source of truth. The apps cannot import across repositories, so they carry a
 * copy of each file under `src/lib/conditioning/`. This script refreshes those
 * copies.
 *
 *   node scripts/sync-conditioning.mjs            # copy into the apps
 *   node scripts/sync-conditioning.mjs --check    # fail if the copies drifted
 *
 * `--check` is what CI runs: it exits non-zero when a copy differs from the
 * source, so a rulebook change cannot ship in one app and not the other.
 *
 * By default the copies are taken from the sibling checkouts next to this
 * repository. Pass `--from <path>` to sync from a different checkout of
 * PocketAppsTCG, and `--root <path>` to point the script at a copy of this
 * repository (used by scripts/selftest.mjs).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

const rootIndex = process.argv.indexOf("--root");
const repoRoot =
  rootIndex > -1 && process.argv[rootIndex + 1]
    ? resolve(process.argv[rootIndex + 1])
    : resolve(here, "..");
const appsRoot = resolve(repoRoot, "..");

const fromIndex = process.argv.indexOf("--from");
const sourceRoot =
  fromIndex > -1 && process.argv[fromIndex + 1]
    ? resolve(process.argv[fromIndex + 1])
    : repoRoot;

/** The files that must stay identical across the repository and the apps. */
const SHARED_FILES = ["rubric.ts", "rubric.test.ts"];

const TARGETS = [
  { app: "PocketVendorTCG", dir: join(appsRoot, "PocketVendorTCG", "src", "lib", "conditioning") },
  { app: "PocketVaultTCG", dir: join(appsRoot, "PocketVaultTCG", "src", "lib", "conditioning") },
];

const BANNER = `// Synced from PocketAppsTCG/conditioning by scripts/sync-conditioning.mjs.
// Edit conditioning/rubric.ts in PocketAppsTCG and re-run the sync; do not edit
// this copy by hand.
`;

function digest(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

let drifted = 0;
let written = 0;

for (const file of SHARED_FILES) {
  const sourcePath = join(sourceRoot, "conditioning", file);
  if (!existsSync(sourcePath)) {
    console.error(`missing source: ${sourcePath}`);
    process.exit(1);
  }
  const source = readFileSync(sourcePath, "utf8");
  const content = file.endsWith(".ts") ? BANNER + source : source;

  for (const target of TARGETS) {
    // An app that does not have the conditioning feature yet cannot have
    // drifted from the rulebook: there is nothing to sync. Once the directory
    // exists the check is strict.
    if (!existsSync(target.dir)) {
      console.log(`skipped ${target.app} — no conditioning directory yet`);
      continue;
    }
    const targetPath = join(target.dir, file);
    const current = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : undefined;
    if (current === content) continue;

    if (checkOnly) {
      console.error(
        `drift: ${target.app}/src/lib/conditioning/${file} ` +
          `(copy ${current ? digest(current) : "missing"} != source ${digest(content)})`,
      );
      drifted += 1;
      continue;
    }

    if (!existsSync(target.dir)) mkdirSync(target.dir, { recursive: true });
    writeFileSync(targetPath, content, "utf8");
    console.log(`synced ${target.app}/src/lib/conditioning/${file}`);
    written += 1;
  }
}

if (checkOnly) {
  if (drifted) {
    console.error(`\n${drifted} conditioning file(s) drifted from the shared rulebook.`);
    console.error("Run: node scripts/sync-conditioning.mjs");
    process.exit(1);
  }
  console.log("conditioning rulebook is in sync with both apps");
} else if (!written) {
  console.log("conditioning rulebook already in sync");
} else {
  console.log(`\nsynced ${written} file(s)`);
}
