import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { Credentials } from "./oauth.js";
import { ResponseAccumulator, type RouterResult, type StreamEvent, type StreamPart } from "./response.js";
import type { ResponsesBody } from "./wire.js";
import { continuationRequest, parseSSE, websocketEvents, type ContinuationState } from "./protocol.js";
import type { RouterConfig } from "./config.js";

const CODEX_HTTP_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_WS_URL = "wss://chatgpt.com/backend-api/codex/responses";
const FATAL_CODEX_CODES = new Set([
  "bio_policy",
  "context_length_exceeded",
  "cyber_policy",
  "insufficient_quota",
  "invalid_prompt",
  "invalid_request",
  "invalid_request_error",
  "invalid_value",
  "usage_not_included",
  "usage_limit_reached"
]);
interface Lane {
  socket: WebSocket;
  busy: boolean;
  continuation?: ContinuationState | undefined;
}

interface AcquiredLane {
  key: string;
  lane: Lane;
  reused: boolean;
  retained: boolean;
}

type TransportResult = RouterResult & {
  transport: "websocket" | "sse";
  continuation: string;
};

type RouterError = Error & {
  code?: unknown;
  param?: string | undefined;
  status?: number | undefined;
  closeCode?: number | undefined;
};

const stickySSE = new Set<string>();
const lanes = new Map<string, Lane>();

function logFile(): string {
  return process.env.SAND_CODEX_ROUTER_LOG ||
    path.join(process.env.SAND_DATA_ROOT || path.join(os.homedir(), "sand-data"), "grok-codex-router.log");
}

export function diagnostic(event: Record<string, unknown>): void {
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
  } catch {}
}

function baseHeaders(credentials: Credentials, sessionId: string): Record<string, string> {
  return {
    Authorization: "Bearer " + credentials.access,
    "chatgpt-account-id": credentials.accountId,
    originator: "grok-codex-router",
    "User-Agent": "grok-codex-router (" + process.platform + "; " + process.arch + ")",
    "x-client-request-id": sessionId,
    "session-id": sessionId,
    "thread-id": sessionId
  };
}

function sseHeaders(credentials: Credentials, sessionId: string): Record<string, string> {
  return {
    ...baseHeaders(credentials, sessionId),
    "OpenAI-Beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json"
  };
}

function isOpen(socket: WebSocket | undefined): boolean {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function closeLane(key: string, lane: Lane): void {
  try { lane.socket.close(1000, "router_reset"); } catch {}
  if (lanes.get(key) === lane) lanes.delete(key);
}

function connectWebSocket(headers: Record<string, string>, signal?: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(CODEX_WS_URL, {
      headers,
      handshakeTimeout: 15000,
      perMessageDeflate: false
    });
    let settled = false;
    const cleanup = () => {
      socket.off("open", open);
      socket.off("error", error);
      socket.off("unexpected-response", unexpected);
      signal && signal.removeEventListener("abort", abort);
    };
    const open = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const error = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    };
    const unexpected = (_request: unknown, response: { statusCode: number }) => {
      const cause = new Error("WebSocket handshake failed with HTTP " + response.statusCode) as RouterError;
      cause.status = response.statusCode;
      error(cause);
    };
    const abort = () => {
      try { socket.close(1000, "aborted"); } catch {}
      const cause = new Error("Request was aborted") as RouterError;
      cause.code = "ABORTED";
      error(cause);
    };
    socket.once("open", open);
    socket.once("error", error);
    socket.once("unexpected-response", unexpected);
    signal && signal.addEventListener("abort", abort, { once: true });
    if (signal && signal.aborted) abort();
  });
}

async function acquireLane(
  sessionId: string,
  credentials: Credentials,
  model: string,
  signal?: AbortSignal
): Promise<AcquiredLane> {
  const key = sessionId + "\u0000" + credentials.accountId + "\u0000" + model;
  let cached = lanes.get(key);
  if (cached && !cached.busy && isOpen(cached.socket)) {
    cached.busy = true;
    return { key, lane: cached, reused: true, retained: true };
  }
  if (cached && !isOpen(cached.socket)) {
    closeLane(key, cached);
    cached = undefined;
  }
  const socket = await connectWebSocket(baseHeaders(credentials, sessionId), signal);
  const lane: Lane = { socket, busy: true };
  if (!cached) lanes.set(key, lane);
  return { key, lane, reused: false, retained: !cached };
}

function releaseLane(acquired: AcquiredLane, keep: boolean): void {
  if (!acquired.retained) {
    try { acquired.lane.socket.close(1000, "transient_done"); } catch {}
    return;
  }
  if (!keep || !isOpen(acquired.lane.socket)) {
    closeLane(acquired.key, acquired.lane);
    return;
  }
  acquired.lane.busy = false;
}

function delayFromError(error: RouterError | undefined, attempt: number): number {
  const message = error && error.message || "";
  const match = /try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)/i.exec(message);
  if (match) return Number(match[1]!) * (match[2]!.toLowerCase() === "ms" ? 1 : 1000);
  return Math.min(60000, 200 * 2 ** Math.max(0, attempt - 1)) * (0.9 + Math.random() * 0.2);
}

export function isRetryableProviderError(error: RouterError | undefined): boolean {
  if (!error) return true;
  if (error.code === "ABORTED") return false;
  if (typeof error.code === "string" && FATAL_CODEX_CODES.has(error.code)) return false;
  if (error.status === 400 || error.status === 401 || error.status === 403) return false;
  return true;
}

function immediateSSE(error: RouterError | undefined): boolean {
  return Boolean(error && (error.status === 401 || error.status === 426 || error.closeCode === 1009 ||
    /\b1009\b|message too big/i.test(error.message || "")));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error("Request was aborted"));
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Request was aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function collect(
  events: AsyncIterable<StreamEvent>,
  model: string,
  invocationId: string | undefined
): Promise<RouterResult> {
  const accumulator = new ResponseAccumulator();
  const parts: StreamPart[] = [];
  for await (const event of events) accumulator.consume(event, (part) => parts.push(part));
  if (!accumulator.response) throw new Error("Codex stream closed before response.completed");
  if (accumulator.response.status === "failed" || accumulator.response.status === "cancelled") {
    throw new Error("Codex response ended without a successful result");
  }
  return accumulator.result(model, invocationId, parts);
}

async function websocketAttempt(
  body: ResponsesBody,
  credentials: Credentials,
  sessionId: string,
  invocationId: string | undefined,
  idleTimeoutMs: number,
  signal?: AbortSignal
): Promise<TransportResult> {
  const acquired = await acquireLane(sessionId, credentials, body.model, signal);
  const continuation = continuationRequest(acquired.lane.continuation, body);
  let keep = false;
  diagnostic({
    type: "request",
    transport: "websocket",
    model: body.model,
    sessionId,
    socketReused: acquired.reused,
    continuation: continuation.decision,
    fullInputItems: body.input.length,
    sentInputItems: continuation.body.input.length
  });
  try {
    acquired.lane.socket.send(JSON.stringify({ type: "response.create", ...continuation.body }));
    const result = await collect(websocketEvents(acquired.lane.socket, signal, idleTimeoutMs), body.model, invocationId);
    acquired.lane.continuation = {
      request: body,
      responseId: result.responseId,
      reconstructedItems: result.reconstructedItems
    };
    keep = true;
    return { ...result, transport: "websocket", continuation: continuation.decision };
  } catch (error: unknown) {
    acquired.lane.continuation = undefined;
    throw error;
  } finally {
    releaseLane(acquired, keep);
  }
}

function responseError(status: number, body: string): RouterError {
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { payload = {}; }
  const nested = payload && typeof payload === "object" && "error" in payload ? payload.error : payload;
  const message = nested && typeof nested === "object" && "message" in nested ? String(nested.message) : undefined;
  const error = new Error(message || "Codex request failed with HTTP " + status) as RouterError;
  error.status = status;
  if (nested && typeof nested === "object") {
    error.code = "code" in nested ? nested.code : "type" in nested ? nested.type : undefined;
    error.param = "param" in nested && typeof nested.param === "string" ? nested.param : undefined;
  }
  return error;
}

async function openSSE(
  body: ResponsesBody,
  credentials: Credentials,
  sessionId: string,
  signal?: AbortSignal
): Promise<Response> {
  let lastError: RouterError | undefined;
  for (let attempt = 0; attempt <= 4; attempt++) {
    const timeout = AbortSignal.timeout(20000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(CODEX_HTTP_URL, {
        method: "POST",
        headers: sseHeaders(credentials, sessionId),
        body: JSON.stringify(body),
        signal: combined
      });
      if (response.ok) return response;
      const error = responseError(response.status, await response.text());
      if (!isRetryableProviderError(error) || attempt === 4) throw error;
      lastError = error;
    } catch (error: unknown) {
      if (signal && signal.aborted) throw error;
      lastError = error instanceof Error ? error as RouterError : new Error(String(error));
      if (attempt === 4 || !isRetryableProviderError(lastError)) throw lastError;
    }
    await sleep(delayFromError(lastError, attempt + 1), signal);
  }
  throw lastError || new Error("Codex SSE request failed");
}

async function sseAttempt(
  body: ResponsesBody,
  credentials: Credentials,
  sessionId: string,
  invocationId: string | undefined,
  idleTimeoutMs: number,
  signal?: AbortSignal
): Promise<TransportResult> {
  diagnostic({
    type: "request",
    transport: "sse",
    model: body.model,
    sessionId,
    fullInputItems: body.input.length,
    sentInputItems: body.input.length
  });
  const response = await openSSE(body, credentials, sessionId, signal);
  const result = await collect(parseSSE(response, signal, idleTimeoutMs), body.model, invocationId);
  return { ...result, transport: "sse", continuation: "disabled" };
}

export async function runTransport(options: {
  body: ResponsesBody;
  credentials: Credentials;
  sessionId: string;
  invocationId?: string | undefined;
  config: RouterConfig;
  signal?: AbortSignal | undefined;
}): Promise<TransportResult> {
  const { body, credentials, sessionId, invocationId, config, signal } = options;
  const preferred = config.transport.mode;
  const useSSE = preferred === "sse" || stickySSE.has(sessionId);
  let waitedMs = 0;
  let lastError: RouterError | undefined;
  if (!useSSE) {
    for (let attempt = 0; attempt <= config.transport.maxRetries; attempt++) {
      try {
        const result = await websocketAttempt(
          body,
          credentials,
          sessionId,
          invocationId,
          config.transport.idleTimeoutMs,
          signal
        );
        diagnosticUsage(result, sessionId, body.model);
        if (preferred === "websocket") closeSession(sessionId);
        return result;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error as RouterError : new Error(String(error));
        diagnostic({ type: "failure", transport: "websocket", model: body.model, sessionId, attempt: attempt + 1, code: lastError.code, param: lastError.param, status: lastError.status });
        if (signal && signal.aborted) throw lastError;
        if (immediateSSE(lastError)) {
          if (lastError.status !== 401) stickySSE.add(sessionId);
          break;
        }
        if (!isRetryableProviderError(lastError)) throw lastError;
        if (attempt === config.transport.maxRetries) {
          stickySSE.add(sessionId);
          break;
        }
        const delay = delayFromError(lastError, attempt + 1);
        if (waitedMs + delay > 180000) throw new Error("Codex retry wait exceeded three minutes", { cause: lastError });
        waitedMs += delay;
        await sleep(delay, signal);
      }
    }
  }
  for (let attempt = 0; attempt <= config.transport.maxRetries; attempt++) {
    try {
      const result = await sseAttempt(body, credentials, sessionId, invocationId, config.transport.idleTimeoutMs, signal);
      diagnosticUsage(result, sessionId, body.model);
      return result;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error as RouterError : new Error(String(error));
      diagnostic({ type: "failure", transport: "sse", model: body.model, sessionId, attempt: attempt + 1, code: lastError.code, param: lastError.param, status: lastError.status });
      if (signal && signal.aborted) throw lastError;
      if (!isRetryableProviderError(lastError) || attempt === config.transport.maxRetries) throw lastError;
      const delay = delayFromError(lastError, attempt + 1);
      if (waitedMs + delay > 180000) throw new Error("Codex retry wait exceeded three minutes", { cause: lastError });
      waitedMs += delay;
      await sleep(delay, signal);
    }
  }
  throw lastError || new Error("Codex transport failed");
}

function diagnosticUsage(result: TransportResult, sessionId: string, model: string): void {
  diagnostic({
    type: "usage",
    transport: result.transport,
    model,
    sessionId,
    inputTokens: result.extendedUsage.inputTokens,
    cachedInputTokens: result.extendedUsage.cacheReadTokens,
    cacheWriteInputTokens: result.extendedUsage.cacheWriteTokens,
    outputTokens: result.extendedUsage.outputTokens,
    continuation: result.continuation
  });
}

export function closeSession(sessionId: string): void {
  for (const [key, lane] of lanes) {
    if (key.startsWith(sessionId + "\u0000")) closeLane(key, lane);
  }
  stickySSE.delete(sessionId);
}

export function closeAll(): void {
  for (const [key, lane] of lanes) closeLane(key, lane);
  stickySSE.clear();
}
