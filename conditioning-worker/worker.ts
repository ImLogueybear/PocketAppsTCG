/**
 * Pocket conditioning Worker (Cloudflare Worker).
 *
 * Holds the DeepSeek key server-side and turns card photos into *observations*
 * — what the model can actually see and where. It never decides the condition:
 * the TCGplayer rulebook does that, deterministically, in `rubric.ts`.
 *
 *   POST /v1/grade  { card, images: [{ label, dataUrl }], rubricVersion }
 *                 -> { rubricVersion, model, observations, notes, usage, tally }
 *   POST /v1/identify { image: dataUrl } | { images: [{ label, dataUrl }] }
 *                 -> { name, set, number, confidence, provider, model, usage }
 *   GET  /v1/rubric
 *                 -> { rubricVersion, rules }
 *
 * The Worker never stores or logs image bytes. It logs the rubric version, the
 * model, the token usage and the shape of the answer, which is exactly what the
 * evaluation harness needs and nothing that identifies a card.
 */

import {
  RUBRIC_VERSION,
  buildConditioningPrompt,
  renderRulesText,
  tally,
  type TallyObservation,
  type TallyResult,
} from "../conditioning/rubric";

interface Env {
  DEEPSEEK_KEY?: string;
  /** Ollama Cloud key. Used when CONDITION_PROVIDER is "ollama". */
  OLLAMA_API_KEY?: string;
  /** Which provider to call. "deepseek" (default) or "ollama". */
  CONDITION_PROVIDER?: string;
  /** Vision model id. Defaults per provider. */
  CONDITION_MODEL?: string;
  /** Set to "1" to allow a caller-supplied provider key (development only). */
  CONDITION_ALLOW_CALLER_KEY?: string;
}

const MAX_IMAGES = 24;
const MAX_BODY_BYTES = 40 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * The providers the grading service can call.
 *
 * Both speak the OpenAI chat-completions shape and both support JSON mode,
 * vision and reasoning control, so only three things differ: the endpoint, how
 * thinking is asked for, and how an image is encoded.
 */
interface Provider {
  id: string;
  baseUrl: string;
  /** The secret that holds the API key. */
  keySecret: "DEEPSEEK_KEY" | "OLLAMA_API_KEY";
  defaultModel: string;
  /** How to ask for thinking, and how to turn it off. */
  thinking: (effort: "high" | "none") => Record<string, unknown>;
  /** How an image is encoded in a message content part. */
  image: (dataUrl: string) => unknown;
}

const PROVIDERS: Record<string, Provider> = {
  deepseek: {
    id: "deepseek",
    baseUrl: "https://api.deepseek.com/chat/completions",
    keySecret: "DEEPSEEK_KEY",
    defaultModel: "deepseek-flash",
    thinking: (effort) =>
      effort === "none"
        ? { reasoning_effort: "none" }
        : { thinking: { type: "enabled" }, reasoning_effort: "high" },
    image: (dataUrl) => ({
      type: "image_url",
      image_url: { url: dataUrl, detail: "original" },
    }),
  },
  ollama: {
    id: "ollama",
    baseUrl: "https://ollama.com/v1/chat/completions",
    keySecret: "OLLAMA_API_KEY",
    defaultModel: "gemma4:31b",
    thinking: (effort) => ({ reasoning_effort: effort }),
    // Ollama's OpenAI-compatible endpoint takes the data URL directly.
    image: (dataUrl) => ({ type: "image_url", image_url: dataUrl }),
  },
};

function providerFor(env: Env): Provider {
  const id = (env.CONDITION_PROVIDER ?? "deepseek").trim().toLowerCase();
  return PROVIDERS[id] ?? PROVIDERS.deepseek;
}

/** A simple per-IP token bucket so one client cannot drain the key. */
const BUCKET_CAPACITY = 12;
const BUCKET_REFILL_PER_SECOND = 0.2;
const buckets = new Map<string, { tokens: number; updatedAt: number }>();

function allowRequest(ip: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(ip) ?? { tokens: BUCKET_CAPACITY, updatedAt: now };
  bucket.tokens = Math.min(
    BUCKET_CAPACITY,
    bucket.tokens + ((now - bucket.updatedAt) / 1000) * BUCKET_REFILL_PER_SECOND,
  );
  bucket.updatedAt = now;
  if (bucket.tokens < 1) {
    buckets.set(ip, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(ip, bucket);
  return true;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type,x-api-key",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...extra },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Request and response shapes
// ─────────────────────────────────────────────────────────────────────────────

interface GradeImage {
  label: string;
  /** A `data:image/...;base64,...` URL. */
  dataUrl: string;
}

interface GradeRequest {
  card?: {
    name?: string;
    setName?: string;
    number?: string;
    holo?: boolean;
    printingEra?: string;
    rarity?: string;
  };
  images?: GradeImage[];
  rubricVersion?: string;
  note?: string;
  /** Development only: override the configured provider and model. */
  provider?: string;
  model?: string;
}

interface ModelObservation {
  id?: string;
  /** 1-based index of the image the imperfection was seen in. */
  image?: number;
  type?: string;
  side?: string;
  bbox?: number[];
  severity?: string;
  confidence?: number;
  note?: string;
  integrity?: boolean;
}

/** An observation as the apps receive it: the bbox is in image coordinates. */
export interface WorkerObservation {
  /** The label of the image the imperfection was seen in. */
  image: string;
  type: string;
  side?: "front" | "back";
  /** [x, y, w, h] as a fraction of that image. */
  bbox?: number[];
  severity?: string;
  confidence?: number;
  note?: string;
  integrity?: boolean;
}

interface ModelAnswer {
  observations?: ModelObservation[];
  photoQuality?: { blurred?: string[]; glare?: string[]; unusable?: string[] };
  notes?: string[];
}

const SEVERITY_WORDS = new Set(["Slight", "Minor", "Moderate", "Major"]);
const KNOWN_TYPES = new Set([
  "Edgewear",
  "Scuffing",
  "Scratch",
  "Surface Wear",
  "Grime",
  "Indentation",
  "Bend",
  "Curling",
  "Fault",
  "Defect",
  "Damage",
]);

function isSeverity(value: unknown): value is "Slight" | "Minor" | "Moderate" | "Major" {
  return typeof value === "string" && SEVERITY_WORDS.has(value);
}

/** Normalise what the model sent into the shape the apps consume. */
function normaliseObservations(answer: ModelAnswer, images: GradeImage[]): {
  observations: WorkerObservation[];
  rejected: number;
} {
  const out: WorkerObservation[] = [];
  let rejected = 0;
  for (const raw of answer.observations ?? []) {
    const type = typeof raw.type === "string" ? raw.type.trim() : "";
    if (!KNOWN_TYPES.has(type)) {
      rejected += 1;
      continue;
    }
    const index = typeof raw.image === "number" ? Math.round(raw.image) : 0;
    const image = images[index - 1];
    if (!image) {
      rejected += 1;
      continue;
    }
    const bbox =
      Array.isArray(raw.bbox) && raw.bbox.length === 4
        ? raw.bbox.filter((value) => typeof value === "number" && Number.isFinite(value))
        : undefined;
    out.push({
      image: image.label,
      type,
      side: raw.side === "back" ? "back" : raw.side === "front" ? "front" : undefined,
      bbox: bbox && bbox.length === 4 ? bbox : undefined,
      severity: isSeverity(raw.severity) ? raw.severity : undefined,
      confidence:
        typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
          ? Math.max(0, Math.min(1, raw.confidence))
          : undefined,
      note: typeof raw.note === "string" ? raw.note : undefined,
      integrity: raw.integrity === true,
    });
  }
  return { observations: out, rejected };
}

// ─────────────────────────────────────────────────────────────────────────────
// DeepSeek
// ─────────────────────────────────────────────────────────────────────────────

interface DeepSeekAttempt {
  content: string;
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
}

async function callProvider(
  provider: Provider,
  apiKey: string,
  model: string,
  systemPrompt: string,
  images: GradeImage[],
  options: { thinking: boolean; maxTokens: number },
  userPrompt = "Report the imperfections you can see on this card. Reply with JSON only.",
): Promise<DeepSeekAttempt> {
  const content: unknown[] = [
    {
      type: "text",
      text: userPrompt,
    },
  ];
  for (const image of images) {
    content.push(provider.image(image.dataUrl));
  }

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content },
    ],
    response_format: { type: "json_object" },
    max_tokens: options.maxTokens,
    stream: false,
    ...provider.thinking(options.thinking ? "high" : "none"),
  };

  const response = await fetch(provider.baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `${provider.id} returned HTTP ${response.status}: ${detail.slice(0, 400)}`
    );
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = payload.choices?.[0];
  return {
    content: choice?.message?.content ?? "",
    finishReason: choice?.finish_reason ?? null,
    promptTokens: payload.usage?.prompt_tokens ?? 0,
    completionTokens: payload.usage?.completion_tokens ?? 0,
  };
}

/**
 * Call the model, retrying when the answer is unusable.
 *
 * DeepSeek's JSON mode replaces output it cannot parse with spaces, so a blank
 * `content` is a real failure mode rather than a bug in the answer. Thinking
 * mode is on by default and its reasoning tokens count against `max_tokens`,
 * which is how a condition request can come back truncated.
 */
async function askModel(
  provider: Provider,
  apiKey: string,
  model: string,
  systemPrompt: string,
  images: GradeImage[],
): Promise<{ answer: ModelAnswer; attempts: number; usage: { promptTokens: number; completionTokens: number } }> {
  const plans = [
    { thinking: true, maxTokens: 4000 },
    { thinking: true, maxTokens: 8000 },
    { thinking: false, maxTokens: 4000 },
  ];
  let promptTokens = 0;
  let completionTokens = 0;
  let lastError: unknown;

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    let attempt: DeepSeekAttempt;
    try {
      attempt = await callProvider(provider, apiKey, model, systemPrompt, images, plan);
    } catch (error) {
      lastError = error;
      continue;
    }
    promptTokens += attempt.promptTokens;
    completionTokens += attempt.completionTokens;

    const trimmed = attempt.content.trim();
    if (!trimmed) {
      lastError = new Error(`${provider.id} returned an empty answer`);
      continue;
    }
    if (attempt.finishReason === "length") {
      lastError = new Error(`${provider.id} truncated the answer`);
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as ModelAnswer;
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      return {
        answer: parsed,
        attempts: index + 1,
        usage: { promptTokens, completionTokens },
      };
    } catch {
      lastError = new Error(`${provider.id} returned something that is not JSON`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("The grading model could not be used");
}

// ─────────────────────────────────────────────────────────────────────────────
// Identification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vision identification for the scan fallback. The app matches artwork
 * on-device first and only asks this route when it is not confident (foil,
 * full-art or textured cards). It returns the printed text so the app can map
 * it onto its own catalogue; the Worker never owns the catalogue.
 */
const IDENTIFY_PROMPT = `You identify a single Pokémon trading card from a photo. Read the text printed on the card itself; do not guess from the artwork alone.

Reply with ONLY a JSON object, no prose:
{"name": string, "set": string, "number": string, "confidence": number}

- name: the exact printed name, keeping suffixes exactly as printed, e.g. "Mew ex", "Charizard VMAX", "Regirock ☆".
- set: the set code or abbreviation printed on the card if visible (e.g. "SVP", "EN", "SWSH"), else the set name if you are certain.
- number: the collector number exactly as printed (e.g. "053", "53/75", "SVP 053").
- confidence: 0 to 1 for the whole identification.

If any field is not legible, omit it rather than inventing it.`;

interface IdentifyAnswer {
  name?: unknown;
  set?: unknown;
  number?: unknown;
  confidence?: unknown;
}

function normaliseIdentify(
  answer: IdentifyAnswer,
): { name: string; set: string; number: string; confidence: number } | null {
  const name = typeof answer.name === "string" ? answer.name.trim() : "";
  const set = typeof answer.set === "string" ? answer.set.trim() : "";
  const number = typeof answer.number === "string" ? answer.number.trim() : "";
  if (!name && !number) return null;
  const raw = typeof answer.confidence === "number" ? answer.confidence : 0.6;
  return {
    name,
    set,
    number,
    confidence: Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 0.6)),
  };
}

/**
 * Ask the model to read one card. Identification is a much smaller answer than
 * grading, so the token plans are smaller; the retry shape matches `askModel`
 * because DeepSeek's JSON mode can still return a blank when it truncates.
 */
async function askIdentify(
  provider: Provider,
  apiKey: string,
  model: string,
  image: GradeImage,
): Promise<{
  answer: IdentifyAnswer;
  attempts: number;
  usage: { promptTokens: number; completionTokens: number };
}> {
  const plans = [
    { thinking: false, maxTokens: 400 },
    { thinking: true, maxTokens: 1200 },
  ];
  let promptTokens = 0;
  let completionTokens = 0;
  let lastError: unknown;

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    let attempt: DeepSeekAttempt;
    try {
      attempt = await callProvider(
        provider,
        apiKey,
        model,
        IDENTIFY_PROMPT,
        [image],
        plan,
        "Read the printed text on this card and reply with JSON only.",
      );
    } catch (error) {
      lastError = error;
      continue;
    }
    promptTokens += attempt.promptTokens;
    completionTokens += attempt.completionTokens;

    const trimmed = attempt.content.trim();
    if (!trimmed) {
      lastError = new Error(`${provider.id} returned an empty answer`);
      continue;
    }
    if (attempt.finishReason === "length") {
      lastError = new Error(`${provider.id} truncated the answer`);
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as IdentifyAnswer;
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      return {
        answer: parsed,
        attempts: index + 1,
        usage: { promptTokens, completionTokens },
      };
    } catch {
      lastError = new Error(`${provider.id} returned something that is not JSON`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("The identification model could not be used");
}

function identifyImage(payload: { image?: unknown; images?: unknown }): GradeImage | null {
  if (typeof payload.image === "string" && payload.image.startsWith("data:image/")) {
    return { label: "card", dataUrl: payload.image };
  }
  if (Array.isArray(payload.images)) {
    const first = payload.images.find(
      (image) => typeof image?.dataUrl === "string" && image.dataUrl.startsWith("data:image/"),
    );
    if (first) {
      return {
        label: typeof first.label === "string" ? first.label : "card",
        dataUrl: first.dataUrl,
      };
    }
  }
  return null;
}

async function handleIdentify(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!allowRequest(ip)) {
    return json({ error: "Too many requests. Try again shortly." }, 429);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength && declaredLength > MAX_BODY_BYTES) {
    return json({ error: "The request is too large." }, 413);
  }

  let payload: { image?: unknown; images?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return json({ error: "The request body is not valid JSON." }, 400);
  }

  const image = identifyImage(payload);
  if (!image) return json({ error: "No image was supplied." }, 400);

  const provider = providerFor(env);
  const apiKey =
    provider.keySecret === "OLLAMA_API_KEY" ? env.OLLAMA_API_KEY : env.DEEPSEEK_KEY;
  if (!apiKey) return json({ error: "The identification service is not configured." }, 500);

  const model = env.CONDITION_MODEL?.trim() || provider.defaultModel;

  let result: {
    answer: IdentifyAnswer;
    attempts: number;
    usage: { promptTokens: number; completionTokens: number };
  };
  try {
    result = await askIdentify(provider, apiKey, model, image);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The identification model failed.";
    console.log(
      JSON.stringify({
        event: "identify_failed",
        provider: provider.id,
        model,
        message,
      }),
    );
    return json({ error: message }, 502);
  }

  const identified = normaliseIdentify(result.answer);
  if (!identified) {
    return json({ error: "The model could not read the card." }, 422);
  }

  console.log(
    JSON.stringify({
      event: "identify",
      provider: provider.id,
      model,
      hasName: Boolean(identified.name),
      hasNumber: Boolean(identified.number),
      confidence: identified.confidence,
      attempts: result.attempts,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
    }),
  );

  return json({
    ...identified,
    provider: provider.id,
    model,
    usage: result.usage,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleGrade(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!allowRequest(ip)) {
    return json({ error: "Too many grading requests. Try again shortly." }, 429);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength && declaredLength > MAX_BODY_BYTES) {
    return json({ error: "The request is too large." }, 413);
  }

  let payload: GradeRequest;
  try {
    payload = (await request.json()) as GradeRequest;
  } catch {
    return json({ error: "The request body is not valid JSON." }, 400);
  }

  const images = (payload.images ?? []).filter(
    (image) => typeof image?.dataUrl === "string" && image.dataUrl.startsWith("data:image/"),
  );
  if (!images.length) {
    return json({ error: "No images were supplied." }, 400);
  }
  if (images.length > MAX_IMAGES) {
    return json({ error: `Too many images (${images.length}); the limit is ${MAX_IMAGES}.` }, 400);
  }

  const callerKey = request.headers.get("x-api-key")?.trim();
  const devMode = env.CONDITION_ALLOW_CALLER_KEY === "1";

  // In development the caller may pick the provider and model, so a different
  // vision model can be tried against the evaluation set without a redeploy.
  // The override only works with the development flag set.
  const requestedProvider = devMode && payload.provider ? payload.provider.trim().toLowerCase() : "";
  const provider = requestedProvider
    ? (PROVIDERS[requestedProvider] ?? providerFor(env))
    : providerFor(env);

  const apiKey =
    callerKey && devMode
      ? callerKey
      : provider.keySecret === "OLLAMA_API_KEY"
        ? env.OLLAMA_API_KEY
        : env.DEEPSEEK_KEY;
  if (!apiKey) {
    return json({ error: "The grading service is not configured." }, 500);
  }

  const model =
    (devMode && payload.model?.trim()) || env.CONDITION_MODEL?.trim() || provider.defaultModel;
  const prompt = buildConditioningPrompt({
    card: payload.card,
    photoLabels: images.map((image) => image.label),
    note: payload.note,
  });

  let result: { answer: ModelAnswer; attempts: number; usage: { promptTokens: number; completionTokens: number } };
  try {
    result = await askModel(provider, apiKey, model, prompt, images);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The grading model failed.";
    console.log(
      JSON.stringify({
        event: "grade_failed",
        rubricVersion: RUBRIC_VERSION,
        provider: provider.id,
        model,
        message,
      })
    );
    return json({ error: message }, 502);
  }

  const { observations, rejected } = normaliseObservations(result.answer, images);
  // The Worker can only apply the rulebook to the model's own severity labels,
  // because it has no idea how big the card was in the photo. The app re-measures
  // the bounding boxes against the card and recomputes; its answer is the one
  // that gets shown.
  const tallyResult: TallyResult = tally(
    observations.map((observation) => ({
      type: observation.type as TallyObservation["type"],
      side: observation.side,
      severity: observation.severity as TallyObservation["severity"],
      confidence: observation.confidence,
      note: observation.note,
      integrity: observation.integrity,
      source: "model",
    })),
  );

  const photoQuality = result.answer.photoQuality ?? {};
  console.log(
    JSON.stringify({
      event: "grade",
      rubricVersion: RUBRIC_VERSION,
      provider: provider.id,
      model,
      images: images.length,
      observations: observations.length,
      rejected,
      points: tallyResult.points,
      condition: tallyResult.condition,
      attempts: result.attempts,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      unusablePhotos: (photoQuality.unusable ?? []).length,
    }),
  );

  return json({
    rubricVersion: RUBRIC_VERSION,
    provider: provider.id,
    model,
    observations,
    photoQuality,
    notes: result.answer.notes ?? [],
    usage: result.usage,
    tally: tallyResult,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/v1/rubric") {
      return json({ rubricVersion: RUBRIC_VERSION, rules: renderRulesText() });
    }
    if (request.method === "POST" && url.pathname === "/v1/grade") {
      return handleGrade(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/identify") {
      return handleIdentify(request, env);
    }
    return json({ error: "Not found" }, 404);
  },
};
