# Pocket conditioning Worker

The shared grading service behind the condition checkers in **PocketVendorTCG**
and **PocketVaultTCG**. It holds the DeepSeek key server-side, asks the vision
model what it can see on a card, and hands the observations back. It does not
decide the condition — the TCGplayer rulebook in [`../conditioning/rubric.ts`](../conditioning/rubric.ts)
does, deterministically, in the app.

## Endpoints

### `POST /v1/grade`

```jsonc
{
  "card": { "name": "Pikachu", "setName": "Base Set", "number": "4", "holo": true },
  "images": [
    { "label": "front of the card, whole card", "dataUrl": "data:image/jpeg;base64,..." },
    { "label": "back of the card, whole card", "dataUrl": "data:image/jpeg;base64,..." }
  ],
  "rubricVersion": "2026.11.08-1"
}
```

```jsonc
{
  "rubricVersion": "2026.11.08-1",
  "model": "deepseek-flash",
  "observations": [
    {
      "type": "Surface Wear",
      "side": "back",
      "bbox": [0.52, 0.41, 0.014, 0.011],
      "severity": "Slight",
      "confidence": 0.82,
      "note": "single pinpoint of white on the back"
    }
  ],
  "photoQuality": { "blurred": [], "glare": [], "unusable": [] },
  "notes": [],
  "usage": { "promptTokens": 9123, "completionTokens": 1840 },
  "tally": { "condition": "LP", "points": 2, "...": "..." }
}
```

`observations[].bbox` is `[x, y, w, h]` normalised to the **card** rectangle, so
the app can convert it to millimetres against a 63mm × 88mm card and decide the
severity itself rather than trusting the model's judgement.

`tally` is the rulebook applied to the model's own severity labels, with no
measurement. The app re-measures the bounding boxes and recomputes; its result
is the one that is shown.

### `GET /v1/rubric`

Returns `{ rubricVersion, rules }` — the version the service is running and the
rulebook as text. The apps compare this with their own bundled version and warn
when they drift.

## Configuration

| Binding | Required | Purpose |
| --- | --- | --- |
| `DEEPSEEK_KEY` | for DeepSeek | The DeepSeek API key. Never ships in an app. |
| `OLLAMA_API_KEY` | for Ollama | The Ollama Cloud API key. Never ships in an app. |
| `CONDITION_PROVIDER` | no | `"deepseek"` (default) or `"ollama"`. Set in `wrangler.toml` under `[vars]`. |
| `CONDITION_MODEL` | no | Vision model id. Defaults per provider. |
| `CONDITION_ALLOW_CALLER_KEY` | no | Set to `"1"` to let a caller pass its own key in `x-api-key` and override the provider and model. Development only. |

Set a secret with:

```bash
npx wrangler secret put DEEPSEEK_KEY
npx wrangler secret put OLLAMA_API_KEY
```

### Providers

Both providers speak the OpenAI chat-completions shape and support JSON mode,
vision and reasoning control, so only the endpoint, the thinking parameter and
the image encoding differ.

**DeepSeek** (`https://api.deepseek.com/chat/completions`) — `deepseek-flash`
is the only DeepSeek model with vision. Thinking is requested with
`thinking: {type: "enabled"}` and `reasoning_effort`. Images are encoded as
`image_url: {url, detail}`.

**Ollama Cloud** (`https://ollama.com/v1/chat/completions`) — the OpenAI-compatible
endpoint, no Ollama install needed. Thinking is requested with `reasoning_effort`
(`"none"` turns it off). Images are encoded as a bare data-URL string, which is
what Ollama's own documentation shows.

Vision models available on Ollama Cloud, all of which also support thinking:

| Model | Input / output per 1M tokens | Notes |
| --- | --- | --- |
| `gemma4:31b` | $0.14 / $0.40 | Gemma 4, 32.7B, BF16. The cheapest strong option. |
| `mimo-v2.6-pro` | $0.435 / $0.87 | |
| `mistral-large-4` | $0.70 / $2.10 | |
| `muse-spark-open` | $1.25 / $4.25 | |
| `kimi-k3` | $3.00 / $15.00 | |
| `deepseek-v4.1-flash` | $0.30 / $1.20 | The same model as the DeepSeek default, so routing it through Ollama changes nothing but which account pays. |

Off-peak pricing (outside 12:00–18:00 UTC on weekdays, and all day at weekends)
roughly halves the DeepSeek and `gemma4` figures.

A grade is roughly 17k input tokens and 1–3k output tokens, so about **$0.003–0.005**
per card either way.

### Switching provider or model

```bash
# Ollama, default model
npm run worker:deploy -- --var CONDITION_PROVIDER:ollama

# Ollama, a specific vision model
npm run worker:deploy -- --var CONDITION_PROVIDER:ollama --var CONDITION_MODEL:gemma4:31b
```

With `CONDITION_ALLOW_CALLER_KEY` set to `"1"`, a caller can also override the
provider and model per request, which is what the evaluation harness uses to try
several models without a redeploy each time.

## Deploy

The Worker lives in this repository and deploys to
`https://pocket-condition.blogue-e68.workers.dev` — the same `workers.dev`
subdomain as the existing `pocketvault-prices` proxy.

```bash
npm install                    # once, installs esbuild and typescript
npx wrangler login             # only if this machine has not logged in yet
npm run worker:deploy          # builds the bundle, then deploys it
```

Set the key once:

```bash
npx wrangler secret put DEEPSEEK_KEY
```

`npm run worker:deploy` bundles `worker.ts` + `rubric.ts` into
`conditioning-worker/dist/worker.js` before deploying, because the Worker bundles
the rulebook in — a rubric change only reaches the apps after it has been
deployed here.

To try it without deploying:

```bash
npm run worker:dev            # http://localhost:8787
node scripts/eval-conditioning.mjs --url http://localhost:8787
```

The apps point at `https://pocket-condition.blogue-e68.workers.dev` by default;
`VITE_CONDITION_WORKER_URL` overrides it.

## What it does with the photos

It sends them to DeepSeek and **nothing else**. No image bytes are logged and
no image is stored. The structured log line contains the rubric version, the
model, the token usage, the number of observations and the resulting condition —
enough to measure accuracy, nothing that identifies a card.

## Cost

A grade sends 2–11 images. DeepSeek bills at most 1024 tokens per image, so a
grade is roughly 9k–12k input tokens and 1k–3k output tokens: **about $0.005**
per card at `deepseek-flash` off-peak rates.

## Notes

- `max_tokens` is deliberately generous. DeepSeek's thinking mode is on by
  default and its reasoning tokens count against the limit, so a tight budget
  silently truncates the JSON and the answer comes back blank.
- Blank or truncated answers are retried with a larger budget, then with
  thinking mode off.
- A per-IP token bucket keeps one client from draining the key.
