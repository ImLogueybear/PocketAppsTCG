#!/usr/bin/env node
/**
 * Proves the validator actually rejects the outage that shipped.
 *
 * Each case copies this repository, mutates one manifest, and asserts the
 * validator exits non-zero with the expected reason. Without this, the guard in
 * validate.mjs could rot into "always passes" and nobody would notice.
 *
 *   node scripts/selftest.mjs             # offline cases
 *   node scripts/selftest.mjs --network   # also proves a dead URL is caught
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function withCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "pocketapps-selftest-"));
  const index = JSON.parse(readFileSync(join(repoRoot, "index.json"), "utf8"));
  const roots = [
    "index.json",
    "policy.json",
    "schemas",
    "scripts",
    "licensing",
    "pkmndb",
    ...index.apps.map((app) => app.id),
  ];
  for (const name of roots) cpSync(join(repoRoot, name), join(dir, name), { recursive: true });
  mutate(dir);
  try {
    const output = execFileSync(process.execPath, [join(dir, "scripts", "validate.mjs"), "--offline"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function editManifest(dir, app, edit) {
  const path = join(dir, app, "updates.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  edit(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

const cases = [
  { name: "clean repository passes", mutate: () => {}, expectPass: true },
  {
    name: "release page as url is rejected",
    mutate: (dir) =>
      editManifest(dir, "pocketvaulttcg", (m) => {
        m.url = `https://github.com/ImLogueybear/PocketVaultTCG/releases/tag/${m.tag}`;
      }),
    expect: /release \*page\*/i,
  },
  {
    name: "missing url is rejected",
    mutate: (dir) => editManifest(dir, "pocketvendortcg", (m) => delete m.url),
    expect: /has no url/i,
  },
  {
    name: "missing sha256 is rejected",
    mutate: (dir) => editManifest(dir, "pocketscantcg", (m) => delete m.sha256),
    expect: /has no sha256/i,
  },
  {
    name: "http url is rejected",
    mutate: (dir) =>
      editManifest(dir, "pocketvaulttcg", (m) => (m.url = m.url.replace("https:", "http:"))),
    expect: /must be https/i,
  },
  {
    name: "snapshot disagreeing with the manifest is rejected",
    mutate: (dir) => {
      const manifest = JSON.parse(
        readFileSync(join(dir, "pocketvaulttcg", "updates.json"), "utf8"),
      );
      const path = join(dir, "pocketvaulttcg", "versions", `${manifest.tag}.json`);
      const snapshot = JSON.parse(readFileSync(path, "utf8"));
      snapshot.url = "https://example.com/other.apk";
      writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
    },
    expect: /disagrees with/i,
  },
];

const networkCases = [
  {
    // The artifact exists, but the advertised URL 404s. Only a real fetch can
    // tell the difference between that and a healthy manifest.
    name: "dead download is rejected (network)",
    mutate: (dir) =>
      editManifest(dir, "pocketvaulttcg", (m) => {
        m.url = m.url.replace("PocketVaultTCG-", "does-not-exist-");
        m.sha256 = "a".repeat(64);
      }),
    expect: /404|unreachable|returned HTTP/i,
    offline: false,
  },
  {
    // Digest and length can only be proven against the real bytes.
    name: "wrong sha256 is rejected (network)",
    mutate: (dir) => editManifest(dir, "pocketvaulttcg", (m) => (m.sha256 = "0".repeat(64))),
    expect: /sha256 mismatch/i,
    offline: false,
  },
  {
    name: "wrong size is rejected (network)",
    mutate: (dir) => editManifest(dir, "pocketvendortcg", (m) => (m.size = 1)),
    expect: /bytes but the manifest says/i,
    offline: false,
  },
];

function runCase(testCase) {
  const dir = mkdtempSync(join(tmpdir(), "pocketapps-selftest-"));
  const index = JSON.parse(readFileSync(join(repoRoot, "index.json"), "utf8"));
  const roots = [
    "index.json",
    "policy.json",
    "schemas",
    "scripts",
    "licensing",
    "pkmndb",
    ...index.apps.map((app) => app.id),
  ];
  for (const name of roots) cpSync(join(repoRoot, name), join(dir, name), { recursive: true });
  testCase.mutate(dir);
  const cliArgs = [join(repoRoot, "scripts", "validate.mjs"), "--root", dir];
  if (testCase.offline !== false) cliArgs.push("--offline");
  try {
    const output = execFileSync(process.execPath, cliArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let failures = 0;
const selected = process.argv.includes("--network")
  ? [...cases, ...networkCases]
  : cases;

for (const testCase of selected) {
  const result = runCase(testCase);
  const passed = testCase.expectPass
    ? result.ok
    : !result.ok && testCase.expect.test(result.output);
  if (passed) {
    console.log(`ok  : ${testCase.name}`);
  } else {
    failures++;
    console.error(`FAIL: ${testCase.name}`);
    console.error(result.output.split("\n").slice(0, 8).join("\n"));
  }
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURES`);
if (failures > 0) process.exit(1);
