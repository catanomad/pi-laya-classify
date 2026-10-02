/**
 * Tests for the laya-classify extension.
 *
 * Runs with plain `node --test` (Node ≥24: native TypeScript type stripping —
 * no dev dependencies). A local HTTP server stands in for laya-serve and the
 * extension is loaded from a temp directory with a custom models.json, exactly
 * the way pi loads it: same index.ts, same local node_modules resolution.
 */
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------
// Mock laya-serve
// ---------------------------------------------------------------------------

interface MockLaya {
  url: string;
  reqs: { method: string; url: string; body?: any }[];
  setHealth(body: unknown): void;
  setSystemOne(handler: (body: any) => unknown): void;
  setSystemOneStatus(status: number): void;
  setSystemOneDelay(ms: number): void;
  close(): Promise<void>;
}

/** Build a canned SystemOne response that answers every question by type. */
function layaResponse(body: any): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  const stateTokens = Math.max(1, Math.round(JSON.stringify(body.state ?? {}).length / 4));
  let totalIn = 0;
  for (const [key, q] of Object.entries<any>(body.questions ?? {})) {
    if (q.type === "choice") {
      const opts = Object.keys(q.criteria);
      answers[key] = {
        type: "choice",
        choice: opts[0],
        probabilities: Object.fromEntries(opts.map((o) => [o, 1 / opts.length])),
        confidence: 1 / opts.length,
      };
      totalIn += stateTokens;
    } else if (q.type === "score") {
      answers[key] = { type: "score", score: 1.25, confidence: 0.9 };
      totalIn += stateTokens;
    } else if (q.type === "noul") {
      answers[key] = { type: "noul", noul: 0.75, logit: 1.1 };
      totalIn += stateTokens;
    }
  }
  return {
    model: body.model ?? "auto",
    answers,
    usage: { input_tokens: totalIn, output_tokens: 0 },
  };
}

interface MockState {
  health: unknown;
  systemOne: (body: any) => unknown;
  systemOneStatus: number;
  systemOneDelay: number;
}

function startMockLaya(): Promise<MockLaya> {
  const state: MockState = {
    health: { status: "ok", loaded: ["multilingual", "english"], device: "cpu" },
    systemOne: layaResponse,
    systemOneStatus: 200,
    systemOneDelay: 0,
  };
  const reqs: { method: string; url: string; body?: any }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url ?? "";
      let body: any;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          /* non-JSON body */
        }
      }
      reqs.push({ method: req.method ?? "", url, body });

      if (req.method === "GET" && url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(state.health));
        return;
      }
      if (req.method === "POST" && url === "/v1/systemone") {
        setTimeout(() => {
          res.writeHead(state.systemOneStatus, { "content-type": "application/json" });
          res.end(JSON.stringify(state.systemOne(body)));
        }, state.systemOneDelay);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "not found" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        reqs,
        setHealth: (h) => (state.health = h),
        setSystemOne: (fn) => (state.systemOne = fn),
        setSystemOneStatus: (s) => (state.systemOneStatus = s),
        setSystemOneDelay: (ms) => (state.systemOneDelay = ms),
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Extension loading
// ---------------------------------------------------------------------------

function tempExtDir(modelsJson: unknown): string {
  const dir = mkdtempSync(join(os.tmpdir(), "laya-classify-ext-"));
  copyFileSync(join(ROOT, "index.ts"), join(dir, "index.ts"));
  writeFileSync(join(dir, "models.json"), JSON.stringify(modelsJson, null, 2));
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "junction");
  return dir;
}

/** Load index.ts from `dir` (fresh module instance) and register it. */
async function register(dir: string): Promise<any> {
  const providers: any[] = [];
  const factory = (await import(pathToFileURL(join(dir, "index.ts")).href)).default;
  factory({ registerProvider: (p: any) => providers.push(p) });
  assert.equal(providers.length, 1);
  return providers[0];
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let mock: MockLaya;
const tempDirs: string[] = [];

function trackedTempDir(modelsJson: unknown): string {
  const dir = tempExtDir(modelsJson);
  tempDirs.push(dir);
  return dir;
}

const TEST_CONFIG = (url: string): unknown => ({
  endpoint: url,
  timeoutMs: 5000,
  models: [
    { id: "laya-multilingual", name: "Laya (Multilingual)", model: "multilingual", contextWindow: 8192 },
    { id: "laya-english", name: "Laya (English)", model: "english", contextWindow: 512, timeoutMs: 250 },
  ],
});

const QUESTIONS = {
  yesno: { type: "bool", instructions: "Is the state dangerous?", criteria: { true: "dangerous", false: "safe" } },
  level: { type: "choice", instructions: "Pick a level.", criteria: { low: "low", high: "high" } },
  magnitude: { type: "score", instructions: "Score the magnitude.", criteria: ["0", "1", "2"] },
};

before(async () => {
  mock = await startMockLaya();
});

after(async () => {
  await mock.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Registration (real models.json)
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("registers the laya provider with the models from models.json", async () => {
    const provider = await register(ROOT);
    assert.equal(provider.id, "laya");
    assert.equal(provider.name, "Laya");
    assert.equal(provider.baseUrl, "http://localhost:1338");

    const models = provider.getAllModels();
    assert.deepEqual(
      models.map((m: any) => m.id),
      ["laya-multilingual", "laya-english"],
    );
    for (const m of models) {
      assert.equal(m.type, "classifier");
      assert.equal(m.api, "laya-classify");
      assert.equal(m.provider, "laya");
      assert.deepEqual(m.input, ["text"]);
      assert.equal(m.cost.input, 0);
      assert.equal(m.cost.total ?? m.cost.output, 0);
    }
    assert.equal(models[1].contextWindow, 512);
    assert.equal(provider.getModels().length, 0);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("classify (happy path)", () => {
  it("maps bool/choice/score answers and sends checkpoint + max_len", async () => {
    const dir = trackedTempDir(TEST_CONFIG(mock.url));
    const provider = await register(dir);
    const model = provider.getAllModels().find((m: any) => m.id === "laya-multilingual");

    const res = await provider.classify(model, { state: { x: 1 }, questions: QUESTIONS });

    assert.equal(res.stopReason, "stop");
    assert.equal(res.provider, "laya");
    assert.equal(res.model, "laya-multilingual");
    assert.deepEqual(res.answers, {
      yesno: { type: "bool", probability: 0.75 },
      level: { type: "choice", choice: "low", probabilities: { low: 0.5, high: 0.5 }, confidence: 0.5 },
      magnitude: { type: "score", score: 1.25, confidence: 0.9 },
    });
    assert.ok(res.usage.input > 0);
    assert.equal(res.usage.output, 0);
    assert.equal(res.usage.cost.total, 0);

    // Health probe ran first, then the classify request.
    assert.equal(mock.reqs[0].url, "/health");
    const req = mock.reqs.find((r) => r.url === "/v1/systemone")!;
    assert.equal(req.method, "POST");
    assert.equal(req.body.model, "multilingual");
    assert.equal(req.body.max_len, 8192);
    assert.deepEqual(req.body.state, { x: 1 });
    // Pi "bool" is translated to Laya "noul" on the wire.
    assert.equal(req.body.questions.yesno.type, "noul");
    assert.deepEqual(req.body.questions.yesno.criteria, { true: "dangerous", false: "safe" });
    assert.equal(req.body.questions.level.type, "choice");
  });

  it("uses the per-model checkpoint and contextWindow", async () => {
    const dir = trackedTempDir(TEST_CONFIG(mock.url));
    const provider = await register(dir);
    const model = provider.getAllModels().find((m: any) => m.id === "laya-english");

    const res = await provider.classify(model, { state: { x: 2 }, questions: { q: QUESTIONS.magnitude } });

    assert.equal(res.stopReason, "stop");
    assert.equal(res.model, "laya-english");
    const req = mock.reqs.filter((r) => r.url === "/v1/systemone").at(-1)!;
    assert.equal(req.body.model, "english");
    assert.equal(req.body.max_len, 512);
  });

  it("caches the health probe across classify calls", async () => {
    const dir = trackedTempDir(TEST_CONFIG(mock.url));
    const provider = await register(dir);
    const model = provider.getAllModels().find((m: any) => m.id === "laya-multilingual");
    const healthBefore = mock.reqs.filter((r) => r.url === "/health").length;

    await provider.classify(model, { state: { a: 1 }, questions: { q: QUESTIONS.yesno } });
    await provider.classify(model, { state: { a: 2 }, questions: { q: QUESTIONS.yesno } });

    const healthAfter = mock.reqs.filter((r) => r.url === "/health").length;
    assert.equal(healthAfter, healthBefore + 1);
  });

  it("accepts the generated { ok, models } health shape", async () => {
    mock.setHealth({ ok: true, models: ["multilingual"] });
    const dir = trackedTempDir(TEST_CONFIG(mock.url));
    const provider = await register(dir);
    const model = provider.getAllModels().find((m: any) => m.id === "laya-multilingual");
    const res = await provider.classify(model, { state: { a: 1 }, questions: { q: QUESTIONS.yesno } });
    assert.equal(res.stopReason, "stop");
    mock.setHealth({ status: "ok", loaded: ["multilingual"], device: "cpu" });
  });
});

// ---------------------------------------------------------------------------
// Health probe failures
// ---------------------------------------------------------------------------

describe("classify (health probe)", () => {
  it("fails when the server is unhealthy, then succeeds once it recovers", async () => {
    mock.setHealth({ status: "error", loaded: [] });
    const dir = trackedTempDir(TEST_CONFIG(mock.url));
    const provider = await register(dir);
    const model = provider.getAllModels().find((m: any) => m.id === "laya-multilingual");

    const bad = await provider.classify(model, { state: { a: 1 }, questions: { q: QUESTIONS.yesno } });
    assert.equal(bad.stopReason, "error");
    assert.match(bad.errorMessage, /not healthy/);

    // A failed probe is not cached: the next call re-probes and succeeds.
    mock.setHealth({ status: "ok", loaded: ["multilingual"], device: "cpu" });
    const good = await provider.classify(model, { state: { a: 1 }, questions: { q: QUESTIONS.yesno } });
    assert.equal(good.stopReason, "stop");
  });

  it("rejects a 500 /health with an error result", async () => {
    // Simulated via a status-carrying health body the SDK would throw on:
    // instead use a dedicated server that answers /health with 500.
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: "boom" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const dir = trackedTempDir(TEST_CONFIG(`http://127.0.0.1:${port}`));
      const provider = await register(dir);
      const model = provider.getAllModels().find((m: any) => m.id === "laya-multilingual");
      const res = await provider.classify(model, { state: { a: 1 }, questions: { q: QUESTIONS.yesno } });
      assert.equal(res.stopReason, "error");
      assert.match(res.errorMessage, /500/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// Truncation & usage
// ---------------------------------------------------------------------------

describe("classify (truncation)", () => {
  it("fails loudly when the server truncated the state", async () => {
    mock.setSystemOne((body) => ({
      ...layaResponse(body),
      usage: {
        input_tokens: 100,
        output_tokens: 0,
        truncated: true,
        state_tokens: 8192,
        state_tokens_dropped: 123,
        truncated_questions: ["q"],
      },
    }));
    const dir = trackedTempDir(TEST_CONFIG(mock.url));
    const provider = await register(dir);
    const model = provider.getAllModels().find((m: any) => m.id === "laya-multilingual");

    const res = await provider.classify(model, { state: { big: "x".repeat(5000) }, questions: { q: QUESTIONS.yesno } });

    assert.equal(res.stopReason, "error");
    assert.match(res.errorMessage, /123 of 8192 state tokens were dropped/);
    assert.match(res.errorMessage, /question\(s\) truncated: q/);
    assert.equal(res.usage.input, 100);
    mock.setSystemOne(layaResponse);
  });

  it("returns answers when usage is clean (no truncation flag)", async () => {
    mock.setSystemOne((body) => ({
      ...layaResponse(body),
      usage: {
        input_tokens: (layaResponse(body) as { usage: { input_tokens: number } }).usage.input_tokens,
        output_tokens: 0,
        truncated: false,
        state_tokens: 10,
        state_tokens_dropped: 0,
      },
    }));
    const dir = trackedTempDir(TEST_CONFIG(mock.url));
    const provider = await register(dir);
    const model = provider.getAllModels().find((m: any) => m.id === "laya-multilingual");
    const res = await provider.classify(model, { state: { a: 1 }, questions: { q: QUESTIONS.yesno } });
    assert.equal(res.stopReason, "stop");
    mock.setSystemOne(layaResponse);
  });
});

// ---------------------------------------------------------------------------
// Abort & timeout
// ---------------------------------------------------------------------------

describe("classify (abort & timeout)", () => {
  it("returns 'aborted' for a pre-aborted signal without touching the network", async () => {
    const dir = trackedTempDir(TEST_CONFIG(mock.url));
    const provider = await register(dir);
    const model = provider.getAllModels().find((m: any) => m.id === "laya-multilingual");
    const sysOneBefore = mock.reqs.filter((r) => r.url === "/v1/systemone").length;

    const ac = new AbortController();
    ac.abort();
    const res = await provider.classify(model, { state: { a: 1 }, questions: { q: QUESTIONS.yesno } }, { signal: ac.signal });

    assert.equal(res.stopReason, "aborted");
    assert.match(res.errorMessage, /aborted/);
    assert.equal(mock.reqs.filter((r) => r.url === "/v1/systemone").length, sysOneBefore);
  });

  it("aborts an in-flight request when the caller's signal fires", async () => {
    mock.setSystemOneDelay(500);
    const dir = trackedTempDir(TEST_CONFIG(mock.url));
    const provider = await register(dir);
    const model = provider.getAllModels().find((m: any) => m.id === "laya-multilingual");

    const ac = new AbortController();
    const p = provider.classify(model, { state: { a: 1 }, questions: { q: QUESTIONS.yesno } }, { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("caller-stop")), 100);
    const res = await p;

    assert.equal(res.stopReason, "aborted");
    mock.setSystemOneDelay(0);
  });

  it("times out with a TimeoutError message when the per-model timeoutMs elapses", async () => {
    mock.setSystemOneDelay(1000);
    const dir = trackedTempDir(TEST_CONFIG(mock.url));
    const provider = await register(dir);
    const model = provider.getAllModels().find((m: any) => m.id === "laya-english"); // timeoutMs: 250

    const t0 = Date.now();
    const res = await provider.classify(model, { state: { a: 1 }, questions: { q: QUESTIONS.yesno } });
    const elapsed = Date.now() - t0;

    assert.equal(res.stopReason, "error");
    assert.match(res.errorMessage, /timed out after 250 ms/);
    assert.ok(elapsed < 900, `expected fast abort, took ${elapsed} ms`);
    mock.setSystemOneDelay(0);
  });
});

// ---------------------------------------------------------------------------
// Server failures
// ---------------------------------------------------------------------------

describe("classify (server failures)", () => {
  it("maps a 413 state-too-large response to an error result", async () => {
    mock.setSystemOneStatus(413);
    mock.setSystemOne(() => ({ detail: "state too large" }));
    const dir = trackedTempDir(TEST_CONFIG(mock.url));
    const provider = await register(dir);
    const model = provider.getAllModels().find((m: any) => m.id === "laya-multilingual");

    const res = await provider.classify(model, { state: { a: 1 }, questions: { q: QUESTIONS.yesno } });

    assert.equal(res.stopReason, "error");
    assert.match(res.errorMessage, /413/);
    mock.setSystemOneStatus(200);
    mock.setSystemOne(layaResponse);
  });

  it("returns an error when the server is unreachable", async () => {
    const dir = trackedTempDir({
      endpoint: "http://127.0.0.1:1", // port 1: nothing listens, connection refused
      timeoutMs: 5000,
      models: [{ id: "m", model: "english" }],
    });
    const provider = await register(dir);
    const model = provider.getAllModels().find((m: any) => m.id === "m");
    const res = await provider.classify(model, { state: { a: 1 }, questions: { q: QUESTIONS.yesno } });
    assert.equal(res.stopReason, "error");
    assert.ok(res.errorMessage.length > 0);
  });

  it("errors on an unknown answer type from the server", async () => {
    mock.setSystemOne(() => ({
      model: "english",
      answers: { q: { type: "wat", noul: 0.5 } },
      usage: { input_tokens: 5, output_tokens: 0 },
    }));
    const dir = trackedTempDir(TEST_CONFIG(mock.url));
    const provider = await register(dir);
    const model = provider.getAllModels().find((m: any) => m.id === "laya-multilingual");
    const res = await provider.classify(model, { state: { a: 1 }, questions: { q: QUESTIONS.yesno } });
    assert.equal(res.stopReason, "error");
    assert.match(res.errorMessage, /unknown answer type/);
    mock.setSystemOne(layaResponse);
  });
});

// ---------------------------------------------------------------------------
// Input validation & config fallbacks
// ---------------------------------------------------------------------------

describe("input validation & config", () => {
  it("errors when there are no questions", async () => {
    const dir = trackedTempDir(TEST_CONFIG(mock.url));
    const provider = await register(dir);
    const model = provider.getAllModels().find((m: any) => m.id === "laya-multilingual");
    const res = await provider.classify(model, { state: { a: 1 }, questions: {} });
    assert.equal(res.stopReason, "error");
    assert.match(res.errorMessage, /no questions to classify/);
  });

  it("falls back to defaults when models.json is missing", async () => {
    const dir = trackedTempDir(null);
    writeFileSync(join(dir, "models.json"), ""); // placeholder removed below
    // Remove the file so loadConfig() takes the missing-file path.
    require_rmSync(join(dir, "models.json"));
    const provider = await register(dir);
    const models = provider.getAllModels();
    assert.deepEqual(models.map((m: any) => m.id), ["laya-multilingual"]);
    assert.equal(models[0].contextWindow, 8192);
    assert.equal(provider.baseUrl, "http://localhost:1338");
  });

  it("falls back to defaults when models.json is invalid JSON", async () => {
    const dir = trackedTempDir(null);
    writeFileSync(join(dir, "models.json"), "{ not json ");
    const provider = await register(dir);
    const models = provider.getAllModels();
    assert.deepEqual(models.map((m: any) => m.id), ["laya-multilingual"]);
  });

  it("falls back to defaults when models.json has an empty models array", async () => {
    const dir = trackedTempDir({ endpoint: mock.url, models: [] });
    const provider = await register(dir);
    const models = provider.getAllModels();
    assert.deepEqual(models.map((m: any) => m.id), ["laya-multilingual"]);
  });
});

// Local helper: node:fs rmSync (kept separate to keep imports tidy)
import { rmSync as require_rmSync } from "node:fs";
