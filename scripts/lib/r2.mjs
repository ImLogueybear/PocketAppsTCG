import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ALGORITHM = "AWS4-HMAC-SHA256";
const REGION = "auto";
const SERVICE = "s3";

export function loadConfig() {
  const candidates = [
    process.env.POCKETAPPS_R2_CONFIG,
    join(homedir(), ".config", "pocketapps", "r2.json"),
    join(homedir(), ".config", "pkmndb", "r2.json"),
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  }
  const fromEnv = process.env.POCKETAPPS_R2_ACCOUNT_ID && process.env.POCKETAPPS_R2_BUCKET;
  if (fromEnv) {
    return {
      account_id: process.env.POCKETAPPS_R2_ACCOUNT_ID,
      bucket: process.env.POCKETAPPS_R2_BUCKET,
      access_key_id: process.env.POCKETAPPS_R2_ACCESS_KEY_ID,
      secret_access_key: process.env.POCKETAPPS_R2_SECRET_ACCESS_KEY,
      public_base_url: process.env.POCKETAPPS_R2_PUBLIC_BASE_URL,
    };
  }
  throw new Error(
    "No R2 credentials: set POCKETAPPS_R2_* env vars or provide ~/.config/pkmndb/r2.json",
  );
}

const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

function encodePath(key) {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

function signingKey(secret, date) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), REGION), SERVICE), "aws4_request");
}

export async function request(config, method, key, { body, contentType, cacheControl } = {}) {
  const host = `${config.account_id}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${config.bucket}/${encodePath(key)}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body ?? Buffer.alloc(0));

  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headers["content-type"] = contentType;
  if (cacheControl) headers["cache-control"] = cacheControl;

  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((name) => `${name}:${headers[name]}\n`).join("");
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = crypto
    .createHmac("sha256", signingKey(config.secret_access_key, dateStamp))
    .update(stringToSign)
    .digest("hex");

  const authorization = `${ALGORITHM} Credential=${config.access_key_id}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`;

  const res = await fetch(`https://${host}${canonicalUri}`, {
    method,
    headers: {
      ...Object.fromEntries(
        signedHeaders.filter((n) => n !== "host").map((n) => [n, headers[n]]),
      ),
      Authorization: authorization,
    },
    body: method === "PUT" ? body : undefined,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`R2 ${method} ${key} failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
  }
  return res;
}

export function publicUrl(config, key) {
  const base = (config.public_base_url || "").replace(/\/+$/, "");
  if (!base) throw new Error("R2 config has no public_base_url");
  return `${base}/${encodePath(key)}`;
}

export async function putObject(config, key, bytes, { contentType, cacheControl } = {}) {
  await request(config, "PUT", key, { body: bytes, contentType, cacheControl });
  return publicUrl(config, key);
}

export async function findObject(config, key) {
  const res = await request(config, "HEAD", key);
  return { size: Number(res.headers.get("content-length") ?? 0) };
}
