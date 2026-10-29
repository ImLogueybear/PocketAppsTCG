#!/usr/bin/env node
/**
 * Validates every public document in this repository.
 *
 * Shape checks alone are not enough: the PocketVendorTCG/PocketVaultTCG outage
 * happened because `updates.json` advertised a `url` pointing at a *private*
 * repository's release page. The manifest validated, the app fetched it, the
 * user tapped "Update", and got a 404. So this validator also proves, over the
 * network, that each advertised download is anonymously fetchable and actually
 * the artifact it claims to be.
 *
 *   node scripts/validate.mjs             # full validation (network required)
 *   node scripts/validate.mjs --offline   # shape + local consistency only
 *   node scripts/validate.mjs --no-download
 *                                         # network check is HEAD-only
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const args = new Set(process.argv.slice(2));
const offline = args.has("--offline");
const headOnly = offline || args.has("--no-download");

// `--root` lets scripts/selftest.mjs validate a mutated copy of this repository,
// so the checks below can be proven to fail when they should.
const rootArgIndex = process.argv.indexOf("--root");
const root =
  rootArgIndex > -1 ? process.argv[rootArgIndex + 1] : fileURLToPath(new URL("..", import.meta.url));
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const fail = (message) => {
  console.error(`invalid: ${message}`);
  process.exitCode = 1;
};
const warn = (message) => console.warn(`warning: ${message}`);

const DOWNLOAD_TIMEOUT_MS = 45_000;

const index = read("index.json");
if (index.schemaVersion !== 1) fail("index.json schemaVersion must be 1");
if (!Array.isArray(index.apps)) fail("index.json has no apps array");
if (!index.sharedData?.id) fail("index.json has no sharedData entry");

const policy = read(index.policy || "policy.json");
if (policy.schemaVersion !== 1) fail("policy.json schemaVersion must be 1");
if (!policy.dataSources?.pkmndb) fail("policy.json has no dataSources.pkmndb");
if (!policy.pricing?.raw || !policy.pricing?.graded) fail("policy.json has no pricing policy");
if (policy.ai?.provider !== "deepseek") fail("policy.json ai.provider must be deepseek");

const entries = [
  ...index.apps.map((app) => ({ ...app, kind: "app" })),
  { ...index.sharedData, kind: "shared" },
];
const expected = new Set();
const downloads = [];

for (const entry of entries) {
  for (const key of ["id", "name"]) {
    if (!entry[key]) fail(`${entry.id ?? "entry"} is missing ${key}`);
  }
  const manifest = entry.manifest;
  const updates = entry.updates ?? manifest;
  if (!manifest) fail(`${entry.id} has no manifest`);
  expected.add(manifest);
  expected.add(updates);
  if (entry.license) expected.add(entry.license);

  let updateDoc;
  try {
    updateDoc = read(updates);
  } catch (error) {
    fail(`${entry.id} update document missing: ${updates} (${error.message})`);
    continue;
  }
  if (updateDoc.schemaVersion != null && updateDoc.schemaVersion !== 1) {
    fail(`${updates} schemaVersion must be 1 when present`);
  }
  if (updateDoc.appId != null && updateDoc.appId !== entry.id) {
    fail(`${updates} appId ${updateDoc.appId} does not match ${entry.id}`);
  }
  // PKMNDB's manifest is a location document, not a release document.
  if (entry.id === "pkmndb") continue;

  if (!updateDoc.version) {
    fail(`${updates} has no version`);
    continue;
  }
  // A release document without a download URL can never update an install.
  if (typeof updateDoc.url !== "string" || !updateDoc.url) {
    fail(`${updates} has no url; users would have nowhere to download the build`);
    continue;
  }

  let url;
  try {
    url = new URL(updateDoc.url);
  } catch {
    fail(`${updates} url is not absolute: ${updateDoc.url}`);
    continue;
  }
  if (url.protocol !== "https:") fail(`${updates} url must be https: ${updateDoc.url}`);
  if (url.hostname === "github.com" && /\/releases\/tag\//.test(url.pathname)) {
    fail(
      `${updates} url points at a GitHub release *page* (${updateDoc.url}). ` +
        "Release pages of private repositories 404 for end users and are not a download.",
    );
  }
  if (url.hostname === "api.github.com" || url.hostname === "raw.githubusercontent.com") {
    if (/\/releases\/assets\//.test(url.pathname)) {
      fail(`${updates} url uses the authenticated release asset API; publish the APK elsewhere.`);
    }
  }
  if (updateDoc.sha256 != null && !/^[a-f0-9]{64}$/.test(updateDoc.sha256)) {
    fail(`${updates} sha256 must be 64 lowercase hex characters`);
  }
  if (updateDoc.size != null && !(Number.isInteger(updateDoc.size) && updateDoc.size > 0)) {
    fail(`${updates} size must be a positive integer`);
  }
  if (entry.kind === "app") {
    if (!updateDoc.sha256) fail(`${updates} has no sha256 for the downloadable artifact`);
    if (!updateDoc.size) fail(`${updates} has no size for the downloadable artifact`);
  }

  // The current manifest must have an immutable snapshot with identical content.
  const versionsDir = entry.versions;
  const tag = updateDoc.tag || `v${updateDoc.version}`;
  if (versionsDir) {
    const snapshotPath = `${versionsDir.replace(/\/+$/, "")}/${tag}.json`;
    expected.add(snapshotPath);
    if (!existsSync(join(root, snapshotPath))) {
      fail(`${updates} has no version snapshot at ${snapshotPath}`);
    } else {
      const snapshot = read(snapshotPath);
      for (const key of ["version", "build", "tag", "url"]) {
        if (String(snapshot[key] ?? "") !== String(updateDoc[key] ?? "")) {
          fail(
            `${snapshotPath} disagrees with ${updates} on ${key} ` +
              `(${JSON.stringify(snapshot[key])} vs ${JSON.stringify(updateDoc[key])})`,
          );
        }
      }
    }
  }

  downloads.push({ id: entry.id, url: updateDoc.url, sha256: updateDoc.sha256, size: updateDoc.size });
}

// Every snapshot on disk must be self-consistent. History is kept on purpose, so
// an old snapshot that predates this contract only warns; the *current* one must
// always point at a real download, because that is what every client reads.
for (const entry of entries) {
  if (!entry.versions || entry.id === "pkmndb") continue;
  const dir = join(root, entry.versions);
  if (!existsSync(dir)) continue;
  const currentTag = read(entry.updates ?? entry.manifest).tag;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const path = `${entry.versions.replace(/\/+$/, "")}/${file}`;
    const snapshot = read(path);
    const fileTag = file.replace(/\.json$/, "");
    const current = fileTag === currentTag;
    const report = current ? fail : warn;
    if (snapshot.tag && snapshot.tag !== fileTag) {
      report(`${path} is named for ${fileTag} but its tag is ${snapshot.tag}`);
    }
    if (!snapshot.version) report(`${path} has no version`);
    if (typeof snapshot.url !== "string" || !snapshot.url) {
      report(`${path} has no downloadable url`);
    } else {
      try {
        const parsed = new URL(snapshot.url);
        if (parsed.hostname === "github.com" && /\/releases\/tag\//.test(parsed.pathname)) {
          report(`${path} advertises a GitHub release page instead of a download`);
        }
      } catch {
        report(`${path} has an invalid url`);
      }
    }
    if (current && !snapshot.publishedAt) warn(`${path} has no publishedAt`);
  }
}

const licenseDir = join(root, "licensing");
for (const file of readdirSync(licenseDir).filter((f) => f.endsWith(".json"))) {
  const path = `licensing/${file}`;
  if (!expected.has(path)) fail(`${path} is not registered in index.json`);
}

/**
 * Fetch a URL the way an end user's phone would: no credentials, no referrer.
 * Returns the response so callers can inspect status and body.
 */
async function fetchAnonymously(url, init = {}) {
  return fetch(url, {
    redirect: "follow",
    ...init,
    headers: { Accept: "*/*", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
}

async function verifyDownload({ id, url, sha256, size }) {
  let res;
  try {
    res = await fetchAnonymously(url, { method: headOnly ? "HEAD" : "GET" });
  } catch (error) {
    fail(`${id}: download ${url} is unreachable (${error.message})`);
    return;
  }

  if (res.status === 404) {
    fail(
      `${id}: download ${url} returns 404 for anonymous users. ` +
        "A private repository or an expired asset link cannot deliver an update.",
    );
    return;
  }
  if (!res.ok) {
    fail(`${id}: download ${url} returned HTTP ${res.status}`);
    return;
  }
  // A release *page* or an HTML error page would pass a plain status check.
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/html")) {
    fail(`${id}: download ${url} served HTML (${contentType}), not an APK`);
    return;
  }

  if (size) {
    const advertised = Number(res.headers.get("content-length") ?? 0);
    if (advertised && advertised !== size) {
      fail(`${id}: ${url} is ${advertised} bytes but the manifest says ${size}`);
    }
  }

  if (headOnly) {
    console.log(`    head ok  ${id} ${url}`);
    return;
  }

  let body;
  try {
    body = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    fail(`${id}: could not read ${url} (${error.message})`);
    return;
  }
  if (size && body.byteLength !== size) {
    fail(`${id}: downloaded ${body.byteLength} bytes but the manifest says ${size}`);
  }
  if (sha256) {
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== sha256) {
      fail(`${id}: sha256 mismatch for ${url} (download ${digest}, manifest ${sha256})`);
      return;
    }
  }
  if (!body.subarray(0, 2).equals(Buffer.from("PK"))) {
    fail(`${id}: ${url} is not a ZIP/APK container (bad magic bytes)`);
    return;
  }
  console.log(`    fetch ok ${id} ${url} (${body.byteLength} bytes)`);
}

if (offline) {
  console.log("note: --offline skipped the network reachability checks");
} else {
  for (const download of downloads) await verifyDownload(download);
}

if (!process.exitCode) {
  console.log(
    `valid: ${index.apps.length} apps, ` +
      `${readdirSync(licenseDir).filter((f) => f.endsWith(".json")).length} license documents, ` +
      `shared data ${index.sharedData.id}`,
  );
}
