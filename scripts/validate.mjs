#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const fail = (message) => {
  console.error(`invalid: ${message}`);
  process.exitCode = 1;
};

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
  if (entry.id !== "pkmndb" && !updateDoc.version) {
    fail(`${updates} has no version`);
  }

  if (entry.license) {
    let licenseDoc;
    try {
      licenseDoc = read(entry.license);
    } catch (error) {
      fail(`${entry.id} license document missing: ${entry.license} (${error.message})`);
      continue;
    }
    if (licenseDoc.schemaVersion !== 1) fail(`${entry.license} schemaVersion must be 1`);
    if (licenseDoc.appId !== entry.id) {
      fail(`${entry.license} appId ${licenseDoc.appId} does not match ${entry.id}`);
    }
    if (!licenseDoc.status) fail(`${entry.license} has no status`);
    if (!licenseDoc.enforcement) fail(`${entry.license} has no enforcement`);
  }
}

const licenseDir = join(root, "licensing");
for (const file of readdirSync(licenseDir).filter((f) => f.endsWith(".json"))) {
  const path = `licensing/${file}`;
  if (!expected.has(path)) fail(`${path} is not registered in index.json`);
}

if (!process.exitCode) {
  console.log(
    `valid: ${index.apps.length} apps, ${readdirSync(licenseDir).filter((f) => f.endsWith(".json")).length} license documents, shared data ${index.sharedData.id}`,
  );
}
