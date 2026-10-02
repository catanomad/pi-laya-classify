/**
 * laya-classify extension
 *
 * Registers Laya (convaiinnovations/laya) classifier models for a self-hosted
 * `laya-serve` HTTP server (FastAPI/uvicorn, Jev-compatible System-1 decision
 * API), talking to it through the official `@ouijan/laya-client` TypeScript
 * SDK — a typed client generated from the server's own OpenAPI spec.
 *
 * - Endpoint: `endpoint` in models.json (default: http://localhost:1338).
 * - Checkpoint: per-model `model` field sent in every request
 *   (e.g. "multilingual"); omit it to let the server auto-route.
 * - Token budget: per-model `contextWindow` is sent as `max_len` on every
 *   request; the server still caps it at its own LAYA_MAX_TOKEN_BUDGET. It
 *   reflects the server's budget, not a hard per-request cap.
 * - One lazily-constructed shared client; a health probe runs on first use
 *   and is cached.
 * - Timeouts + abort: the client wrapper only forwards the request body, so
 *   each request goes through a fetch wrapper that combines a timeout
 *   AbortSignal with the caller's options.signal.
 *
 * Laya question type "noul" = Pi question type "bool" (P(true), not a typo).
 *
 * NOTE: the shipped SDK API is `createLayaClient({ baseUrl, fetch? })` →
 * `{ systemOne(body), route(body), health() }` (openapi-fetch under the hood,
 * ESM-only). A "new Laya / predict" API does not exist in the published
 * package. The generated HealthResponse type ({ ok, models }) also lags the
 * live server ({ status, loaded }), so the health probe checks both shapes.
 *
 * Config: edit `models.json` in this directory (optional — a sensible default
 * is used when absent), then run `/reload`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLayaClient,
  type LayaClient,
  type SystemOneRequest,
} from "@ouijan/laya-client";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Pi classifier question shapes (mirrors pi-ai's ClassifierQuestion; the type is not re-exported by pi-coding-agent). */
type PiClassifierQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } };

const PROVIDER_ID = "laya";
const API = "laya-classify";
const DEFAULT_ENDPOINT = "http://localhost:1338";
const DEFAULT_CONTEXT_WINDOW = 8192; // laya-serve LAYA_MAX_TOKEN_BUDGET
const DEFAULT_TIMEOUT_MS = 120_000;

interface LayaModelConfig {
  id: string;
  name?: string;
  /** Checkpoint alias sent per request (e.g. "multilingual"). Omit to auto-route. */
  model?: string;
  /** Sent as max_len per request; reflects the server's LAYA_MAX_TOKEN_BUDGET. */
  contextWindow?: number;
  /** Per-model request timeout in ms (falls back to top-level timeoutMs). */
  timeoutMs?: number;
}

interface LayaConfig {
  /** laya-serve base URL, e.g. "http://localhost:1338". */
  endpoint?: string;
  /** Default request timeout in ms. */
  timeoutMs?: number;
  models: LayaModelConfig[];
}

const DEFAULT_CONFIG: LayaConfig = {
  models: [
    {
      id: "laya-multilingual",
      name: "Laya (Multilingual)",
      model: "multilingual",
      contextWindow: DEFAULT_CONTEXT_WINDOW,
    },
  ],
};

function extDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return join(process.env.HOME ?? "", ".pi/agent/extensions/laya-classify");
  }
}

function loadConfig(): LayaConfig {
  const file = join(extDir(), "models.json");
  if (!existsSync(file)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<LayaConfig>;
    if (!Array.isArray(raw.models) || raw.models.length === 0) return DEFAULT_CONFIG;
    return {
      endpoint: raw.endpoint?.trim() || DEFAULT_ENDPOINT,
      timeoutMs: raw.timeoutMs,
      models: raw.models,
    };
  } catch (err) {
    console.error(
      `[laya-classify] failed to parse ${file}: ${err instanceof Error ? err.message : String(err)} — using defaults`,
    );
    return DEFAULT_CONFIG;
  }
}

/**
 * fetch wrapper that enforces a deadline and forwards an outer abort signal.
 * The @ouijan/laya-client wrapper only forwards the request body, so this is
 * the only way to wire timeoutMs and options.signal.
 */
function fetchWithDeadline(timeoutMs: number, outer?: AbortSignal): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort(
        new DOMException(
          `laya-classify: request timed out after ${timeoutMs} ms`,
          "TimeoutError",
        ),
      );
    }, timeoutMs);
    const onOuterAbort = () => ctrl.abort(outer?.reason);
    if (outer) {
      if (outer.aborted) {
        ctrl.abort(outer.reason);
      } else {
        outer.addEventListener("abort", onOuterAbort, { once: true });
      }
    }
    try {
      return await globalThis.fetch(input, { ...init, signal: ctrl.signal });
    } catch (err) {
      if (!timedOut && outer?.aborted && err instanceof Error && err.name === "AbortError") {
        throw outer.reason ?? err;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  };
}

/** Classify a failure: caller abort vs. timeout vs. plain error. */
function classifyFailure(err: unknown, outer?: AbortSignal): {
  stopReason: "aborted" | "error";
  message: string;
} {
  if (outer?.aborted) {
    return { stopReason: "aborted", message: "aborted by caller" };
  }
  if (err instanceof Error && err.name === "TimeoutError") {
    return { stopReason: "error", message: err.message };
  }
  return { stopReason: "error", message: err instanceof Error ? err.message : String(err) };
}

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();

  const models = cfg.models.map((m) => ({
    type: "classifier" as const,
    id: m.id,
    name: m.name ?? m.id,
    api: API,
    provider: PROVIDER_ID,
    baseUrl: cfg.endpoint ?? DEFAULT_ENDPOINT,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
  }));

  const defaultTimeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Shared client, lazily constructed on first classify.
  let sharedClient: LayaClient | null = null;
  let sharedHealth: Promise<void> | null = null;

  function clientFor(timeoutMs: number, outer?: AbortSignal): LayaClient {
    if (!outer && timeoutMs === defaultTimeoutMs) {
      if (!sharedClient) {
        sharedClient = createLayaClient({
          baseUrl: cfg.endpoint ?? DEFAULT_ENDPOINT,
          fetch: fetchWithDeadline(timeoutMs),
        });
      }
      return sharedClient;
    }
    // Per-request client when the caller passes a signal or a custom timeout.
    // Cheap: createLayaClient opens no connections.
    return createLayaClient({
      baseUrl: cfg.endpoint ?? DEFAULT_ENDPOINT,
      fetch: fetchWithDeadline(timeoutMs, outer),
    });
  }

  /** Health probe on first use; result cached, retriable after failure. */
  async function ensureHealthy(): Promise<void> {
    if (!sharedHealth) {
      sharedHealth = (async () => {
        const h = await clientFor(defaultTimeoutMs).health();
        // Generated type says { ok, models }; the live server sends
        // { status: "ok", loaded: [...] } — accept both.
        const ok = (h as { ok?: boolean }).ok === true || (h as { status?: string }).status === "ok";
        if (!ok) {
          throw new Error(`laya-serve at ${cfg.endpoint ?? DEFAULT_ENDPOINT} is not healthy: ${JSON.stringify(h)}`);
        }
      })();
      sharedHealth.catch(() => (sharedHealth = null));
    }
    await sharedHealth;
  }

  /** Laya wire question: Pi "bool" translated to "noul"; choice/score pass through. */
  type LayaQuestion = {
    type: "choice" | "score" | "noul";
    instructions: string;
    criteria?: unknown;
  };

  /** Pi answer shapes (mirrors pi-ai's ClassifierAnswer structurally). */
  type LayaAnswer =
    | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
    | { type: "score"; score: number; confidence: number }
    | { type: "bool"; probability: number };

  /** Pi question -> Laya question: "bool" becomes "noul"; choice/score pass through. */
  function translateQuestion(q: PiClassifierQuestion): LayaQuestion {
    if (q.type === "bool") {
      return { type: "noul", instructions: q.instructions, criteria: q.criteria };
    }
    return q as LayaQuestion;
  }

  function errorResult(model: any, stopReason: "aborted" | "error", message: string, usage?: any): any {
    return {
      api: API,
      provider: PROVIDER_ID,
      model: model?.id ?? "unknown",
      answers: {},
      ...(usage ? { usage } : {}),
      stopReason,
      errorMessage: message,
      timestamp: Date.now(),
    };
  }

  /**
   * laya-serve truncates over-budget input silently (200 + `truncated: true`).
   * The raw usage carries fields the SDK's Usage type omits: truncated,
   * state_tokens, state_tokens_dropped, truncated_questions.
   */
  type RawUsage = {
    input_tokens?: number;
    output_tokens?: number;
    truncated?: boolean;
    state_tokens?: number;
    state_tokens_dropped?: number;
    truncated_questions?: string[];
  };

  function truncationError(model: any, usage: RawUsage, maxLen: number): any {
    const dropped = usage.state_tokens_dropped ?? 0;
    const parts: string[] = [];
    if (dropped > 0) {
      parts.push(`${dropped} of ${usage.state_tokens ?? "?"} state tokens were dropped server-side`);
    }
    if (usage.truncated_questions?.length) {
      parts.push(`question(s) truncated: ${usage.truncated_questions.join(", ")}`);
    }
    return errorResult(
      model,
      "error",
      `state exceeded the token budget (max_len=${maxLen}): ${parts.join("; ") || "server reported truncation"}; ` +
        `shorten the state or raise contextWindow in models.json (server cap: LAYA_MAX_TOKEN_BUDGET)`,
      {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        cost: { total: 0 },
      },
    );
  }

  const provider = {
    id: PROVIDER_ID,
    name: "Laya",
    baseUrl: cfg.endpoint ?? DEFAULT_ENDPOINT,
    auth: {
      apiKey: {
        name: "Laya",
        check: async () => ({ type: "api_key" as const, source: "local" as const }),
        resolve: async () => ({
          auth: { apiKey: "local" },
          source: "local" as const,
        }),
      },
    },
    getModels: () => [],
    getAllModels: () => models,
    classify: async (model: any, context: any, options?: any) => {
      if (options?.signal?.aborted) {
        return errorResult(model, "aborted", "aborted before start");
      }
      try {
        const mcfg = cfg.models.find((c) => c.id === model?.id);
        const timeoutMs = mcfg?.timeoutMs ?? defaultTimeoutMs;
        const questions: Record<string, LayaQuestion> = {};
        const piQuestions = (context?.questions ?? {}) as Record<string, PiClassifierQuestion>;
        for (const [key, q] of Object.entries(piQuestions)) {
          questions[key] = translateQuestion(q);
        }
        if (Object.keys(questions).length === 0) {
          return errorResult(model, "error", "no questions to classify");
        }

        await ensureHealthy();

        const body: SystemOneRequest = {
          state: context?.state ?? {},
          questions,
          model: (mcfg?.model as SystemOneRequest["model"]) ?? null,
          // Not in the generated OpenAPI schema, but laya-serve honors it;
          // the schema's index signature admits extra fields.
          max_len: mcfg?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        } as SystemOneRequest;

        const result = await clientFor(timeoutMs, options?.signal).systemOne(body);

        const answers: Record<string, LayaAnswer> = {};
        for (const key of Object.keys(questions)) {
          const a = result.answers?.[key];
          if (!a) continue;
          switch (a.type) {
            case "choice":
              answers[key] = {
                type: "choice",
                choice: a.choice,
                probabilities: a.probabilities ?? {},
                confidence: a.confidence ?? 0,
              };
              break;
            case "score":
              answers[key] = {
                type: "score",
                score: a.score ?? 0,
                confidence: a.confidence ?? 0,
              };
              break;
            case "noul":
              answers[key] = { type: "bool", probability: a.noul ?? 0 };
              break;
            default:
              throw new Error(`laya-classify: unknown answer type ${String((a as { type?: string }).type)}`);
          }
        }

        const input = result.usage?.input_tokens ?? 0;
        const output = result.usage?.output_tokens ?? 0;

        // Fail loudly on silent server-side truncation instead of returning
        // answers computed on a truncated state.
        const rawUsage = result.usage as RawUsage | undefined;
        if (rawUsage && (rawUsage.truncated === true || (rawUsage.state_tokens_dropped ?? 0) > 0)) {
          return truncationError(model, rawUsage, mcfg?.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
        }

        return {
          api: API,
          provider: PROVIDER_ID,
          model: model?.id ?? "unknown",
          answers,
          usage: {
            input,
            output,
            totalTokens: input + output,
            cost: { total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        };
      } catch (err) {
        const { stopReason, message } = classifyFailure(err, options?.signal);
        return errorResult(model, stopReason, message);
      }
    },
  };

  pi.registerProvider(provider as any);
}
