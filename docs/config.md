# Configuration

The extension reads a single optional file: **`models.json` in the extension
directory** (next to `index.ts`). No environment variables are read. If the
file is missing, unreadable, invalid JSON, or contains an empty `models`
array, the extension logs a warning (for parse failures) and falls back to a
built-in default: one `laya-multilingual` model pointing at
`http://localhost:1338` with `contextWindow: 8192`.

After editing `models.json`, run `/reload` in pi.

## Top level

```jsonc
{
  "endpoint": "http://localhost:1338", // laya-serve base URL
  "timeoutMs": 120000,                 // default per-request timeout (ms)
  "models": [ /* see below */ ]
}
```

| Field       | Type   | Default                 | Description |
| ----------- | ------ | ----------------------- | ----------- |
| `endpoint`  | string | `http://localhost:1338` | Base URL of the running `laya-serve`. Trailing slash not required. |
| `timeoutMs` | number | `120000` | Default per-request timeout in milliseconds. Raise it if the server may download a checkpoint on first use. A per-model `timeoutMs` overrides this. |
| `models`    | array  | built-in default        | One entry per classifier model exposed to pi. Must be a non-empty array. |

## Model entries

```jsonc
{
  "id": "laya-multilingual",     // pi model id — unique within the list
  "name": "Laya (Multilingual)", // display name (defaults to id)
  "model": "multilingual",       // checkpoint alias sent per request
  "contextWindow": 8192,         // sent as max_len on every request
  "timeoutMs": 300000            // optional per-model timeout override
}
```

| Field           | Type   | Default        | Description |
| --------------- | ------ | -------------- | ----------- |
| `id`            | string | — (required)   | Pi model id, unique within `models`. Used in `models.getModelOfType("classifier", "laya", "<id>")`. |
| `name`          | string | the `id`       | Display name. |
| `model`         | string | `null` (auto-route) | Checkpoint alias sent in every `POST /v1/systemone` body. Omit it to let the server pick the checkpoint. Known aliases: `multilingual`/`ml`, `english`/`en`, `typed-decisions`/`typed`. Only checkpoints loaded via the server's `LAYA_MODELS` are resident; others may be fetched on the first request. |
| `contextWindow` | number | `8192`         | Sent as `max_len` on every request. This reflects the server's token budget (`LAYA_MAX_TOKEN_BUDGET`), **not** a hard per-request cap — the server still clamps to its own budget. Match it to the checkpoint's budget (e.g. `512` for the English checkpoint, `8192` for multilingual). |
| `timeoutMs`     | number | top-level `timeoutMs`, then `120000` | Per-request timeout for this model. |

## Example

A `models.json` with two checkpoints:

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

## Behavior notes

- **Over-budget input fails loudly.** laya-serve truncates over-budget state
  silently (HTTP 200 + `truncated: true` in usage). The extension detects that
  and returns `stopReason: "error"` with an `errorMessage` naming the dropped
  tokens — instead of returning answers computed on a truncated state. Fix:
  shorten the state, or raise `contextWindow` (capped by the server's
  `LAYA_MAX_TOKEN_BUDGET`).
- **Hard state size limit**: requests with state larger than 50,000 characters
  get `413 {"detail":"state too large"}` from the server, which the extension
  surfaces as a classify error. The token budget does not lift this limit.
- **Token usage scales with question count**: `usage.input_tokens` is a
  per-question sum because the server repeats the state for every question
  (2 questions ≈ 2 × state tokens).
- **Health probe**: on first use the extension calls `GET /health` and caches
  the result; a failed probe is retried on the next classify call.
