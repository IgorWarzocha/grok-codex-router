import assert from "node:assert/strict";
import test from "node:test";
import { continuationRequest } from "../src/protocol.js";
import { isRetryableProviderError } from "../src/transport.js";
import type { ResponsesBody } from "../src/wire.js";

function body(input: unknown[]): ResponsesBody {
  return {
    model: "gpt-5.6-sol",
    store: false,
    stream: true,
    instructions: "stable",
    input,
    client_metadata: { session_id: "agent-a", thread_id: "agent-a" }
  };
}

test("cached WebSocket continuation sends only the validated new tail", () => {
  const initial = body([{ role: "user", content: "one" }]);
  const reconstructed = [{ type: "message", role: "assistant", content: "answer" }];
  const next = body([...initial.input, ...reconstructed, { role: "user", content: "two" }]);
  const result = continuationRequest({
    request: initial,
    responseId: "resp_1",
    reconstructedItems: reconstructed
  }, next);

  assert.equal(result.decision, "delta");
  assert.equal(result.body.previous_response_id, "resp_1");
  assert.deepEqual(result.body.input, [{ role: "user", content: "two" }]);
});

test("continuation never crosses a changed model contract", () => {
  const initial = body([{ role: "user", content: "one" }]);
  const changed = { ...body(initial.input), instructions: "changed" };
  const result = continuationRequest({
    request: initial,
    responseId: "resp_1",
    reconstructedItems: []
  }, changed);
  assert.equal(result.decision, "body-mismatch");
  assert.equal(result.body.previous_response_id, undefined);
});

test("provider validation failures never enter the transport retry loop", () => {
  const error = new Error("invalid item") as Error & { code?: string };
  error.code = "invalid_value";
  assert.equal(isRetryableProviderError(error), false);
});
