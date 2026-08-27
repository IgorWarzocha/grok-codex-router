import {
  DEFAULT_MAX_RETRY_DELAY_MS,
  DEFAULT_OVERLOAD_INITIAL_RETRY_DELAY_MS,
  DEFAULT_OVERLOAD_RECOVERY_BUDGET_MS,
  DEFAULT_OVERLOAD_RETRY_DELAY_MS,
  DEFAULT_RATE_LIMIT_RECOVERY_BUDGET_MS,
  INITIAL_STREAM_RETRY_DELAY_MS,
  WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE
} from "./codex-policy.js";

export type RouterError = Error & {
  code?: unknown;
  param?: string | undefined;
  status?: number | undefined;
  closeCode?: number | undefined;
  retryable?: boolean | undefined;
  retryDelayMs?: number | undefined;
};

const OVERLOAD_CODES = new Set(["server_is_overloaded", "slow_down"]);
const RETRYABLE_CODES = new Set([
  "previous_response_not_found",
  "rate_limit_exceeded",
  "server_is_overloaded",
  "slow_down",
  "websocket_connection_limit_reached"
]);
const FATAL_CODES = new Set([
  "bio_policy",
  "context_length_exceeded",
  "cyber_policy",
  "insufficient_quota",
  "invalid_prompt",
  "invalid_request",
  "invalid_request_error",
  "usage_not_included",
  "usage_limit_reached"
]);
const TERMINAL_RATE_LIMIT = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|usage_limit_reached|usage_not_included|available balance|insufficient_quota|out of budget|quota exceeded/i;

function stringCode(error: RouterError | undefined): string | undefined {
  return typeof error?.code === "string" ? error.code : undefined;
}

export function asRouterError(error: unknown): RouterError {
  return error instanceof Error ? error as RouterError : new Error(String(error));
}

export function nonRetryableError(message: string, cause?: unknown): RouterError {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as RouterError;
  error.retryable = false;
  return error;
}

export function isRetryableProviderError(error: RouterError | undefined): boolean {
  if (!error) return true;
  if (error.code === "ABORTED" || error.retryable === false) return false;
  if (error.retryable === true) return true;
  const code = stringCode(error);
  if (code === "rate_limit_exceeded" && TERMINAL_RATE_LIMIT.test(`${code} ${error.message}`)) return false;
  if (code && RETRYABLE_CODES.has(code)) return true;
  if (code && FATAL_CODES.has(code)) return false;
  if (error.status !== undefined) return error.status !== 400 && error.status !== 401 && error.status !== 429;
  return true;
}

export function isPermanentWebSocketError(error: RouterError | undefined): boolean {
  return error?.status === 400 || error?.status === 429;
}

export function immediateSSEFallback(error: RouterError | undefined): boolean {
  return Boolean(error && (
    error.status === 401 ||
    error.status === 426 ||
    error.closeCode === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE ||
    /\b1009\b|message too big/i.test(error.message)
  ));
}

function exponentialDelay(retryCount: number): number {
  const base = INITIAL_STREAM_RETRY_DELAY_MS * 2 ** Math.max(0, retryCount - 1);
  return Math.min(DEFAULT_MAX_RETRY_DELAY_MS, base * (0.9 + Math.random() * 0.2));
}

function requestedDelay(error: RouterError | undefined): number | undefined {
  const code = stringCode(error);
  if ((!code || (code !== "rate_limit_exceeded" && !OVERLOAD_CODES.has(code))) || !error) return undefined;
  const match = /try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)/i.exec(error.message);
  if (!match?.[1] || !match[2]) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value * (match[2].toLowerCase() === "ms" ? 1 : 1000);
}

export interface RetryState {
  overloadRetries: number;
  overloadWaitedMs: number;
  rateLimitWaitedMs: number;
}

export interface RetryPlan {
  kind: "ordinary" | "overload" | "rate-limit";
  delayMs?: number | undefined;
}

export function retryPlan(error: RouterError | undefined, retryCount: number, state: RetryState): RetryPlan {
  const code = stringCode(error);
  if (code && OVERLOAD_CODES.has(code)) {
    const remaining = Math.max(0, DEFAULT_OVERLOAD_RECOVERY_BUDGET_MS - state.overloadWaitedMs);
    if (remaining === 0) return { kind: "overload" };
    const fallback = state.overloadRetries === 0
      ? DEFAULT_OVERLOAD_INITIAL_RETRY_DELAY_MS
      : DEFAULT_OVERLOAD_RETRY_DELAY_MS;
    return {
      kind: "overload",
      delayMs: Math.min(DEFAULT_MAX_RETRY_DELAY_MS, remaining, Math.max(fallback, requestedDelay(error) ?? 0))
    };
  }
  if (code === "rate_limit_exceeded") {
    const delayMs = requestedDelay(error) ?? exponentialDelay(retryCount);
    const remaining = Math.max(0, DEFAULT_RATE_LIMIT_RECOVERY_BUDGET_MS - state.rateLimitWaitedMs);
    return { kind: "rate-limit", ...(delayMs <= remaining ? { delayMs } : {}) };
  }
  return { kind: "ordinary", delayMs: exponentialDelay(retryCount) };
}

export function recordRetryWait(state: RetryState, plan: RetryPlan): void {
  if (plan.delayMs === undefined) return;
  if (plan.kind === "overload") {
    state.overloadRetries++;
    state.overloadWaitedMs += plan.delayMs;
  }
  if (plan.kind === "rate-limit") state.rateLimitWaitedMs += plan.delayMs;
}
