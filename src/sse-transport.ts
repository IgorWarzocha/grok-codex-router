import {
  DEFAULT_SSE_HEADER_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_SSE_REQUEST_RETRIES
} from "./codex-policy.js";
import { baseCodexHeaders } from "./codex-headers.js";
import { recordEvent } from "./event-log.js";
import type { Credentials } from "./oauth.js";
import {
  asRouterError,
  retryPlan,
  type RouterError
} from "./recovery.js";
import { collectResponse, type TransportResult } from "./response.js";
import { serializeSseRequest, type SerializedSseRequest } from "./sse-request.js";
import { parseSSE } from "./sse-stream.js";
import {
  CODEX_TURN_STATE_HEADER,
  type CodexTurnState
} from "./turn-state.js";
import type { ResponsesBody } from "./wire.js";

const CODEX_HTTP_URL = "https://chatgpt.com/backend-api/codex/responses";

function headers(
  credentials: Credentials,
  sessionId: string,
  contentEncoding?: string
): Record<string, string> {
  const values: Record<string, string> = {
    ...baseCodexHeaders(credentials, sessionId),
    "OpenAI-Beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json"
  };
  if (contentEncoding) values["content-encoding"] = contentEncoding;
  return values;
}

function responseError(status: number, body: string): RouterError {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = {};
  }
  const nested = payload && typeof payload === "object" && "error" in payload ? payload.error : payload;
  const message = nested && typeof nested === "object" && "message" in nested
    ? String(nested.message)
    : undefined;
  const error = new Error(message || "Codex request failed with HTTP " + status) as RouterError;
  error.status = status;
  if (nested && typeof nested === "object") {
    error.code = "code" in nested ? nested.code : "type" in nested ? nested.type : undefined;
    error.param = "param" in nested && typeof nested.param === "string" ? nested.param : undefined;
  }
  return error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Request was aborted"));
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

async function openSSE(
  request: SerializedSseRequest,
  credentials: Credentials,
  sessionId: string,
  turnState: CodexTurnState,
  signal?: AbortSignal
): Promise<Response> {
  let lastError: RouterError | undefined;
  for (let attempt = 0; attempt <= MAX_SSE_REQUEST_RETRIES; attempt++) {
    const timeout = AbortSignal.timeout(DEFAULT_SSE_HEADER_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      const requestHeaders = headers(credentials, sessionId, request.contentEncoding);
      const currentTurnState = turnState.current();
      if (currentTurnState) requestHeaders[CODEX_TURN_STATE_HEADER] = currentTurnState;
      response = await fetch(CODEX_HTTP_URL, {
        method: "POST",
        headers: requestHeaders,
        body: request.body,
        signal: combined
      });
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      lastError = asRouterError(error);
      if (attempt === MAX_SSE_REQUEST_RETRIES) throw lastError;
      const plan = retryPlan(
        lastError,
        attempt + 1,
        { overloadRetries: 0, overloadWaitedMs: 0, rateLimitWaitedMs: 0 }
      );
      await sleep(plan.delayMs!, signal);
      continue;
    }
    if (response.ok) {
      turnState.capture(response.headers.get(CODEX_TURN_STATE_HEADER));
      return response;
    }
    const error = responseError(response.status, await response.text());
    lastError = error;
    if (error.code === "server_is_overloaded" || error.code === "slow_down") throw error;
    const retryableRequest = response.status >= 500 && response.status <= 599;
    if (!retryableRequest || attempt === MAX_SSE_REQUEST_RETRIES) throw error;
    const plan = retryPlan(
      error,
      attempt + 1,
      { overloadRetries: 0, overloadWaitedMs: 0, rateLimitWaitedMs: 0 }
    );
    await sleep(plan.delayMs!, signal);
  }
  throw lastError || new Error("Codex SSE request failed");
}

export async function sseAttempt(options: {
  body: ResponsesBody;
  credentials: Credentials;
  sessionId: string;
  invocationId: string | undefined;
  turnState: CodexTurnState;
  signal?: AbortSignal | undefined;
}): Promise<TransportResult> {
  const { body, credentials, sessionId, invocationId, turnState, signal } = options;
  recordEvent({
    type: "request",
    transport: "sse",
    model: body.model,
    sessionId,
    fullInputItems: body.input.length,
    sentInputItems: body.input.length
  });
  const response = await openSSE(
    serializeSseRequest(body),
    credentials,
    sessionId,
    turnState,
    signal
  );
  const result = await collectResponse(
    parseSSE(response, signal, DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    body.model,
    invocationId
  );
  return {
    ...result,
    transport: "sse",
    continuation: "disabled",
    socketReused: false
  };
}
