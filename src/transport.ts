import type { RouterConfig } from "./config.js";
import { recordEvent } from "./event-log.js";
import type { Credentials } from "./oauth.js";
import {
  asRouterError,
  immediateSSEFallback,
  isPermanentWebSocketError,
  isRetryableProviderError,
  nonRetryableError,
  recordRetryWait,
  retryPlan,
  type RetryPlan,
  type RetryState,
  type RouterError
} from "./recovery.js";
import type { TransportResult } from "./response.js";
import { sseAttempt } from "./sse-transport.js";
import type { CodexTurnState } from "./turn-state.js";
import {
  closeAllWebSocketSessions,
  isWebSocketSseFallbackActive,
  recordWebSocketSseFallback
} from "./websocket-lanes.js";
import { websocketAttempt } from "./websocket-transport.js";
import type { ResponsesBody } from "./wire.js";

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

function recordFailure(
  transport: "websocket" | "sse",
  model: string,
  sessionId: string,
  attempt: number,
  error: RouterError
): void {
  recordEvent({
    type: "failure",
    transport,
    model,
    sessionId,
    attempt,
    code: error.code,
    param: error.param,
    status: error.status
  });
}

export async function runTransport(options: {
  body: ResponsesBody;
  credentials: Credentials;
  sessionId: string;
  invocationId?: string | undefined;
  config: RouterConfig;
  turnState: CodexTurnState;
  signal?: AbortSignal | undefined;
}): Promise<TransportResult> {
  const { body, credentials, sessionId, invocationId, config, turnState, signal } = options;
  const preferred = config.transport.mode;
  const recovery: RetryState = {
    overloadRetries: 0,
    overloadWaitedMs: 0,
    rateLimitWaitedMs: 0
  };
  let lastError: RouterError | undefined;

  const waitBeforeRetry = async (plan: RetryPlan): Promise<void> => {
    if (plan.delayMs === undefined) return;
    await sleep(plan.delayMs, signal);
    recordRetryWait(recovery, plan);
  };

  const useSSE = preferred === "sse" || isWebSocketSseFallbackActive(sessionId);
  if (!useSSE) {
    for (let attempt = 0; attempt <= config.transport.maxRetries; attempt++) {
      try {
        return await websocketAttempt({
          body,
          credentials,
          sessionId,
          invocationId,
          useCachedContext: preferred === "cached-websocket",
          turnState,
          signal
        });
      } catch (error: unknown) {
        lastError = asRouterError(error);
        recordFailure("websocket", body.model, sessionId, attempt + 1, lastError);
        if (signal?.aborted) throw lastError;
        if (immediateSSEFallback(lastError)) {
          if (lastError.status !== 401) recordWebSocketSseFallback(sessionId);
          break;
        }

        const retryable = !isPermanentWebSocketError(lastError) &&
          isRetryableProviderError(lastError);
        const plan = retryPlan(lastError, attempt + 1, recovery);
        const overloadBudgetExhausted = plan.kind === "overload" && plan.delayMs === undefined;
        const rateLimitBudgetExhausted = plan.kind === "rate-limit" && plan.delayMs === undefined;
        if (
          retryable &&
          attempt < config.transport.maxRetries &&
          !overloadBudgetExhausted &&
          !rateLimitBudgetExhausted
        ) {
          await waitBeforeRetry(plan);
          continue;
        }
        if (rateLimitBudgetExhausted) {
          throw nonRetryableError(
            "Codex throttling exceeded the three-minute automatic recovery window.",
            lastError
          );
        }
        if (!retryable || (!overloadBudgetExhausted && attempt < config.transport.maxRetries)) {
          throw lastError;
        }
        recordWebSocketSseFallback(sessionId);
        break;
      }
    }
  }

  for (let attempt = 0; attempt <= config.transport.maxRetries; attempt++) {
    try {
      return await sseAttempt({
        body,
        credentials,
        sessionId,
        invocationId,
        turnState,
        signal
      });
    } catch (error: unknown) {
      lastError = asRouterError(error);
      recordFailure("sse", body.model, sessionId, attempt + 1, lastError);
      if (signal?.aborted) throw lastError;

      const retryable = isRetryableProviderError(lastError);
      const plan = retryPlan(lastError, attempt + 1, recovery);
      const overloadBudgetExhausted = plan.kind === "overload" && plan.delayMs === undefined;
      const rateLimitBudgetExhausted = plan.kind === "rate-limit" && plan.delayMs === undefined;
      if (
        retryable &&
        attempt < config.transport.maxRetries &&
        !overloadBudgetExhausted &&
        !rateLimitBudgetExhausted
      ) {
        await waitBeforeRetry(plan);
        continue;
      }
      if (rateLimitBudgetExhausted) {
        throw nonRetryableError(
          "Codex throttling exceeded the three-minute automatic recovery window.",
          lastError
        );
      }
      if (retryable) {
        throw nonRetryableError(
          "Codex stream retry budget was exhausted before a response completed.",
          lastError
        );
      }
      throw lastError;
    }
  }
  throw lastError || new Error("Codex transport failed");
}

export function closeAll(): void {
  closeAllWebSocketSessions();
}
