#!/usr/bin/env node
/**
 * Publish one app release to PocketAppsTCG.
 *
 * This is the only supported way to update an app manifest, because it is the
 * only path that guarantees an update is actually installable:
 *
 *   1. Uploads the APK to the public R2 bucket and verifies an anonymous read.
 *   2. Writes `updates.json` with a direct https `url`, the artifact sha256 and
 *      its byte size.
 *   3. Writes the immutable `versions/<tag>.json` snapshot.
 *
 * The previous flow published a *private* GitHub release page as `url`. It
 * validated, shipped, and left every user on a 404 when they tapped Update.
 * Release pages are still recorded, but only in `releaseUrl`, which clients use
 * for changelog links and never as the download target.
 *
 * Usage (from the app repo, typically from a release script):
 *
 *   node ../PocketAppsTCG/scripts/publish-release.mjs \
 *     --app pocketvaulttcg --apk artifacts/PocketVaultTCG-0.33.0-debug.apk \
 *     --release-url https://github.com/ImLogueybear/PocketVaultTCG/releases/tag/v0.33.0 \
 *     --notes-file release-notes.md
 *
 * Flags:
 *   --app <id>          App id from index.json (required)
 *   --apk <path>        Local APK to publish (required unless --url is given)
 *   --url <https url>   Already-public artifact URL to advertise instead
 *   --version <x.y.z>   Defaults to the APK file name, then package.json
 *   --build <n>         Defaults to android/app/build.gradle `versionCode`
 *   --tag <vX.Y.Z>      Defaults to v<version>
 *   --notes <text> / --notes-file <path>
 *   --release-url <u>   Changelog/release page recorded as `releaseUrl`
 *   --dry-run           Print the manifest without uploading or writing
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findObject, loadConfig, publicUrl, putObject } from "./lib/r2.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "dry-run") {
      out.dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) throw new Error(`--${key} needs a value`);
    out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const appId = args.app;
if (!appId) throw new Error("--app <id> is required");

const index = JSON.parse(readFileSync(join(root, "index.json"), "utf8"));
const entry = index.apps.find((app) => app.id === appId);
if (!entry) throw new Error(`Unknown app id '${appId}' (not in index.json)`);

const packageJsonPath = join(root, "..", entry.name, "package.json");
const gradlePath = join(root, "..", entry.name, "android", "app", "build.gradle");

function readVersionFromSources(apkPath) {
  const fromName = apkPath && basename(apkPath).match(/(\d+\.\d+\.\d+)/)?.[1];
  if (fromName) return fromName;
  if (existsSync(packageJsonPath)) {
    return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
  }
  throw new Error("Cannot determine the version; pass --version");
}

function readBuild() {
  if (existsSync(gradlePath)) {
    const match = readFileSync(gradlePath, "utf8").match(/versionCode\s+(\d+)/);
    if (match) return Number.parseInt(match[1], 10);
  }
  throw new Error("Cannot determine the Android versionCode; pass --build");
}

const apkPath = args.apk ? resolve(args.apk) : undefined;
if (!apkPath && !args.url) throw new Error("--apk <path> or --url <https url> is required");
if (apkPath && !existsSync(apkPath)) throw new Error(`APK not found: ${apkPath}`);

const version = (args.version || readVersionFromSources(apkPath)).replace(/^v/i, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Version '${version}' is not x.y.z`);
const tag = args.tag || `v${version}`;
const build = args.build ? Number.parseInt(args.build, 10) : readBuild();

let notes;
if (args.notesFile) notes = readFileSync(resolve(args.notesFile), "utf8").trim();
else if (args.notes) notes = args.notes.trim();

let artifact;
if (apkPath) {
  const bytes = readFileSync(apkPath);
  if (!bytes.subarray(0, 2).equals(Buffer.from("PK"))) {
    throw new Error(`${apkPath} is not a ZIP/APK container`);
  }
  artifact = {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    name: basename(apkPath),
  };
}

const manifestKey = entry.manifest;
const snapshotKey = `${(entry.versions || `${appId}/versions/`).replace(/\/+$/, "")}/${tag}.json`;

const config = loadConfig();
const objectKey = `apps/${appId}/${tag}/${artifact ? artifact.name : "artifact"}`;
const url = artifact ? publicUrl(config, objectKey) : args.url;

const manifest = {
  schemaVersion: 1,
  appId,
  version,
  build,
  tag,
  url,
  sha256: artifact?.sha256,
  size: artifact?.size,
  notes,
  releaseUrl: args.releaseUrl,
  publishedAt: new Date().toISOString(),
};

// Drop undefined keys so the document stays clean and deterministic.
for (const key of Object.keys(manifest)) if (manifest[key] === undefined) delete manifest[key];
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

if (args.dryRun) {
  console.log(manifestText);
  process.exit(0);
}

if (artifact) {
  console.log(`==> uploading ${artifact.name} (${artifact.size} bytes, sha256 ${artifact.sha256})`);
  await putObject(config, objectKey, artifact.bytes, {
    contentType: "application/vnd.android.package-archive",
    // The URL embeds the tag, so it is safe to cache aggressively.
    cacheControl: "public, max-age=31536000, immutable",
  });

  // Prove anonymous readability before any client is told about it.
  const probe = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(45_000) });
  if (!probe.ok) throw new Error(`Published artifact is not anonymously readable: HTTP ${probe.status}`);
  const body = Buffer.from(await probe.arrayBuffer());
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== artifact.sha256) {
    throw new Error(`Anonymous download does not match the uploaded artifact (${digest})`);
  }
  const { size } = await findObject(config, objectKey);
  if (size !== artifact.size) throw new Error(`Stored size ${size} != ${artifact.size}`);
  console.log(`==> verified anonymous download ${url}`);
}

writeFileSync(join(root, manifestKey), manifestText);
writeFileSync(join(root, snapshotKey), manifestText);
console.log(`==> wrote ${manifestKey} and ${snapshotKey} (${version} / ${build})`);

if (process.env.POCKETAPPS_COMMIT === "1") {
  execFileSync("git", ["add", manifestKey, snapshotKey], { cwd: root, stdio: "inherit" });
  execFileSync(
    "git",
    ["commit", "-m", `Publish ${entry.name} ${tag} (build ${build}, sha256 ${artifact?.sha256 ?? "external"})`],
    { cwd: root, stdio: "inherit" },
  );
  console.log("==> committed");
}
