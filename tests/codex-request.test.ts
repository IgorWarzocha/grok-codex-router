import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { serializeSseRequest } from "../src/sse-request.js";
import {
  captureCodexTurnState,
  createCodexTurnState,
  withCodexTurnState
} from "../src/turn-state.js";
import type { ResponsesBody } from "../src/wire.js";

test("the first provider turn state is retained across a native tool loop", () => {
  const state = createCodexTurnState();
  captureCodexTurnState({
    type: "response.metadata",
    headers: { "X-Codex-Turn-State": "turn-1" }
  }, state);
  captureCodexTurnState({
    type: "response.metadata",
    headers: { "x-codex-turn-state": "turn-2" }
  }, state);
  const body = {
    model: "gpt-5.6-sol",
    store: false,
    stream: true,
    instructions: "test",
    input: [],
    client_metadata: { session_id: "session", thread_id: "session" }
  } satisfies ResponsesBody;

  assert.equal(state.current(), "turn-1");
  assert.deepEqual(withCodexTurnState(body, state).client_metadata, {
    session_id: "session",
    thread_id: "session",
    "x-codex-turn-state": "turn-1"
  });
});

test("SSE serialization labels compressed bytes without changing the request", () => {
  const value = { model: "gpt-5.6-sol", input: [{ role: "user", content: "hello" }] };
  const serialized = serializeSseRequest(value);
  const json = serialized.contentEncoding === "zstd"
    ? zlib.zstdDecompressSync(Buffer.from(serialized.body)).toString("utf8")
    : String(serialized.body);
  assert.deepEqual(JSON.parse(json), value);
});
