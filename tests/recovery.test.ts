import assert from "node:assert/strict";
import test from "node:test";
import {
  immediateSSEFallback,
  isPermanentWebSocketError,
  isRetryableProviderError,
  retryPlan,
  type RouterError
} from "../src/recovery.js";

function routerError(
  message: string,
  fields: Partial<Pick<RouterError, "code" | "status" | "closeCode">>
): RouterError {
  return Object.assign(new Error(message), fields);
}

test("provider validation and quota failures never enter automatic retry", () => {
  assert.equal(isRetryableProviderError(
    routerError("invalid image", { code: "invalid_value", status: 400 })
  ), false);
  assert.equal(isRetryableProviderError(
    routerError("monthly usage limit reached", { code: "rate_limit_exceeded", status: 429 })
  ), false);
  assert.equal(isRetryableProviderError(
    routerError("slow down", { code: "slow_down" })
  ), true);
  assert.equal(isRetryableProviderError(
    routerError("temporary edge failure", { status: 403 })
  ), true);
});

test("WebSocket fallback is sticky only for transport incompatibility", () => {
  assert.equal(immediateSSEFallback(routerError("upgrade required", { status: 426 })), true);
  assert.equal(immediateSSEFallback(routerError("frame rejected", { closeCode: 1009 })), true);
  assert.equal(immediateSSEFallback(routerError("unauthorized", { status: 401 })), true);
  assert.equal(immediateSSEFallback(routerError("invalid request", { status: 400 })), false);
  assert.equal(isPermanentWebSocketError(routerError("invalid request", { status: 400 })), true);
  assert.equal(isPermanentWebSocketError(routerError("server error", { status: 500 })), false);
});

test("provider-directed waits cannot exceed the recovery budget", () => {
  const overload = routerError("slow down", { code: "slow_down" });
  assert.equal(retryPlan(overload, 1, {
    overloadRetries: 0,
    overloadWaitedMs: 0,
    rateLimitWaitedMs: 0
  }).delayMs, 30_000);
  assert.equal(retryPlan(overload, 2, {
    overloadRetries: 2,
    overloadWaitedMs: 180_000,
    rateLimitWaitedMs: 0
  }).delayMs, undefined);

  const rateLimit = routerError("try again in 181 seconds", { code: "rate_limit_exceeded" });
  assert.equal(retryPlan(rateLimit, 1, {
    overloadRetries: 0,
    overloadWaitedMs: 0,
    rateLimitWaitedMs: 0
  }).delayMs, undefined);
});
