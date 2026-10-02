# pi-laya-classify

Pi extension that registers [Laya](https://github.com/ouijan/laya) classifier
models for a self-hosted [`laya-serve`](https://pypi.org/project/laya-serve/)
HTTP server, talking to it through the official
[`@ouijan/laya-client`](https://www.npmjs.com/package/@ouijan/laya-client)
TypeScript SDK (typed from the server's OpenAPI spec).

Laya is a Jev-compatible System-1 decision model: one forward pass answers any
number of typed questions (`choice` / `score` / `noul`) about a state. The
extension exposes each configured checkpoint as a pi **classifier** model, so
pi's `models.classify` / codemode classifiers can run local, zero-cost
decisions against your own GPU/CPU box.

## Features

- Registers one classifier model per `models.json` entry
  (provider `laya`, api `laya-classify`)
- Per-model checkpoint, token budget (`max_len`), and timeout
- Health probe on first use, cached (retried after failure)
- Timeout + abort wiring through the client's `fetch` option
  (`options.signal` cancels the in-flight HTTP request)
- **Fails loudly on silent server-side truncation** — never returns answers
  computed on a truncated state
- Self-hosted: zero cost reporting, no API keys

## Install

From pi, install the git package:

```bash
pi install git:github.com/catanomad/pi-laya-classify
```

or clone it into your extensions directory:

```bash
git clone git@github.com:catanomad/pi-laya-classify.git ~/.pi/agent/extensions/pi-laya-classify
npm install --prefix ~/.pi/agent/extensions/pi-laya-classify
```

Then run `/reload` in pi. Pi installs the package's runtime dependencies
(`@ouijan/laya-client`) automatically for git sources; for a manual clone, run
the `npm install` above.

> Requires Node ≥ 22 (the SDK is ESM-only; pi loads the extension with jiti, so
> it resolves without extra work). Tests require Node ≥ 24.

## Server

The extension expects a running `laya-serve` (FastAPI/uvicorn). Reference
launch:

```bash
LAYA_HOST=0.0.0.0 LAYA_PORT=1338 LAYA_MODELS=multilingual LAYA_MAX_TOKEN_BUDGET=8192 \
  uv run laya-serve
# or, with the venv binary directly:
LAYA_HOST=0.0.0.0 LAYA_PORT=1338 LAYA_MODELS=multilingual LAYA_MAX_TOKEN_BUDGET=8192 \
  ~/.venv/bin/laya-serve
```

Endpoints used by the extension:

- `POST /v1/systemone` — body `{ state, questions, model?, max_len? }`
  → `{ model, answers, usage: { input_tokens, output_tokens } }`
- `GET /health` → `{ status: "ok", loaded: [...], device, ... }`

See [laya-serve](https://pypi.org/project/laya-serve/) for full server options.

## Configuration

Edit `models.json` in the extension directory, then run `/reload`. No
environment variables are read. Full reference:
[docs/config.md](docs/config.md).

```json
{
  "endpoint": "http://localhost:1338",
  "timeoutMs": 120000,
  "models": [
    {
      "id": "laya-multilingual",
      "name": "Laya (Multilingual)",
      "model": "multilingual",
      "contextWindow": 8192
    },
    {
      "id": "laya-english",
      "name": "Laya (English)",
      "model": "english",
      "contextWindow": 512
    }
  ]
}
```

If `models.json` is missing or invalid, the extension falls back to one
`laya-multilingual` model at `http://localhost:1338` with
`contextWindow: 8192`.

## Question/answer mapping

| Pi (in) | Laya (wire) | Pi (out) |
|---------|-------------|----------|
| `bool` | `noul` | `{ type: "bool", probability }` |
| `choice` | `choice` | `{ type: "choice", choice, probabilities, confidence }` |
| `score` | `score` | `{ type: "score", score, confidence }` |

`bool` criteria `{ true, false }` are forwarded as the `noul` clarification.
Usage is mapped to `{ input, output, totalTokens, cost: { total: 0 } }`
(self-hosted — no cost).

## Behavior

- One lazily-constructed shared client; a health probe runs on first classify
  and its result is cached (a failed probe is retried on the next call).
- `options.signal` aborts the in-flight HTTP request; pre-aborted calls return
  `stopReason: "aborted"` without touching the network.
- Timeouts and server failures return `stopReason: "error"` with an
  `errorMessage`.
- **Over-budget input fails loudly.** laya-serve truncates over-budget state
  silently (200 + `truncated: true`); this extension detects that in the
  response usage and returns `stopReason: "error"` with an `errorMessage`
  naming the dropped tokens.

### Server behaviors (verified against laya 0.3.22)

- **`max_len` is honored but optional.** Without it, the server truncates the
  state to the checkpoint's shipped default (1024 tokens for multilingual) and
  reports `truncated: true` / `state_tokens_dropped` in usage. That is why this
  extension always sends `max_len` from `contextWindow`.
- **Over-budget is silent degradation, never an HTTP error**: the server
  clamps the forward pass to exactly `max_len` and returns a normal 200 with
  `truncated: true`. The extension converts that into a classify error.
- **State has a hard size limit**: requests with state > 50,000 characters get
  `413 {"detail":"state too large"}` — the token budget does not lift this.
- **`usage.input_tokens` is a per-question sum**: the server repeats the state
  for every question, so input tokens scale with the number of questions.
- The `/health` response shape (`{ status, loaded, device, ... }`) differs from
  the client's generated `HealthResponse` type (`{ ok, models }`); the health
  probe accepts both.

## Development

```bash
npm install        # installs @ouijan/laya-client, @types/node, typescript
npm test           # node:test suite (Node ≥ 24, no dev framework)
npm run typecheck  # strict tsc over index.ts + tests
```

The test suite runs the extension against a local mock of laya-serve
(health, systemone, truncation, abort, timeout, and failure paths) without
needing a GPU or the real server.

## License

[MIT](LICENSE)
