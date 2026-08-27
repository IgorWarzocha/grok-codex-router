import assert from "node:assert/strict";
import test from "node:test";
import { continuationRequest } from "../src/continuation.js";
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

test("continuation sends only the tail after an exact reconstructed prefix", () => {
  const initial = body([{ role: "user", content: "one" }]);
  const reconstructed = [{
    type: "message",
    id: "provider-message-id",
    role: "assistant",
    content: "answer"
  }];
  const rebuilt = [{
    type: "message",
    id: "grok-rebuilt-id",
    role: "assistant",
    content: "answer"
  }];
  const next = body([...initial.input, ...rebuilt, { role: "user", content: "two" }]);

  const result = continuationRequest({
    request: initial,
    responseId: "resp_1",
    reconstructedItems: reconstructed
  }, next);

  assert.equal(result.decision, "delta");
  assert.equal(result.body.previous_response_id, "resp_1");
  assert.deepEqual(result.body.input, [{ role: "user", content: "two" }]);
});

test("continuation rejects a changed request contract or history prefix", () => {
  const initial = body([{ role: "user", content: "one" }]);
  const state = {
    request: initial,
    responseId: "resp_1",
    reconstructedItems: [{ type: "message", role: "assistant", content: "answer" }]
  };

  assert.equal(
    continuationRequest(state, { ...body(initial.input), instructions: "changed" }).decision,
    "body-mismatch"
  );
  assert.equal(
    continuationRequest(state, body(initial.input)).decision,
    "input-shorter-than-baseline"
  );
  assert.equal(
    continuationRequest(
      state,
      body([...initial.input, { type: "message", role: "assistant", content: "different" }])
    ).decision,
    "input-prefix-mismatch"
  );
});

test("a tool result can recover an omitted assistant call without crossing response state", () => {
  const initial = body([{ role: "user", content: "check" }]);
  const state = {
    request: initial,
    responseId: "resp_tool",
    reconstructedItems: [
      { type: "function_call", call_id: "call_1", name: "Check", arguments: "{}" }
    ]
  };
  const next = body([
    ...initial.input,
    { type: "function_call_output", call_id: "call_1", output: "ok" }
  ]);

  const result = continuationRequest(state, next);
  assert.equal(result.decision, "delta");
  assert.equal(result.body.previous_response_id, "resp_tool");
  assert.deepEqual(result.body.input, [
    { type: "function_call_output", call_id: "call_1", output: "ok" }
  ]);

  assert.equal(
    continuationRequest({ ...state, responseId: undefined }, next).decision,
    "missing-response-id"
  );
});
