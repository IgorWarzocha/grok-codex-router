import assert from "node:assert/strict";
import test from "node:test";
import { convertMessages } from "../src/message-wire.js";
import { reportContextWindow, ResponseAccumulator } from "../src/response.js";
import { convertTools } from "../src/tool-wire.js";
import { buildRequest } from "../src/wire.js";

test("Grok tool wrappers become Codex Responses tools without losing schemas", () => {
  const wrappedSchema = {};
  Object.defineProperty(wrappedSchema, "jsonSchema", {
    enumerable: false,
    get: () => ({
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"]
    })
  });
  const tools = convertTools([{
    name: "send_message",
    description: "Send a message",
    parameters: wrappedSchema
  }]);
  assert.deepEqual(tools?.[0]?.["parameters"], {
    type: "object",
    properties: { content: { type: "string" } },
    required: ["content"]
  });
});

test("native delivery tools become closed discriminated variants", () => {
  const properties: Record<string, Record<string, unknown>> = Object.fromEntries([
    "type", "content", "images", "reply_to", "channel", "to", "url", "alt",
    "widget", "bcId", "secret"
  ].map((name) => [name, { type: "string" }]));
  properties["type"] = {
    type: "string",
    enum: ["text", "attachment", "widget", "cursor-agent", "secret-request"]
  };
  const tools = convertTools([{
    name: "send_to_user",
    parameters: {
      jsonSchema: { type: "object", properties }
    }
  }]);
  const schema = tools?.[0]?.["parameters"] as Record<string, unknown>;
  const variants = schema["oneOf"] as Array<Record<string, unknown>>;

  assert.equal(variants.length, 5);
  assert.deepEqual(variants[0]?.["required"], ["type", "content"]);
  assert.equal(variants.every((variant) => variant["additionalProperties"] === false), true);
});

test("legacy Grok tool IDs stay paired after deterministic Codex clamping", () => {
  const id = "tool_" + "legacy-grok-call-id_".repeat(5);
  const converted = convertMessages([
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "Shell", args: { command: "true" } }]
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: id, result: "ok" }]
    }
  ]);
  const call = converted.input[0] as Record<string, unknown>;
  const output = converted.input[1] as Record<string, unknown>;
  assert.equal(String(call["call_id"]).length, 64);
  assert.equal(output["call_id"], call["call_id"]);
});

test("Grok image payloads become valid Codex data URLs without forwarding local paths", () => {
  const converted = convertMessages([{
    role: "user",
    content: [
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      { type: "image_url", url: "/workspace/uploads/private.png" }
    ]
  }]);
  assert.deepEqual(converted.input, [{
    role: "user",
    content: [
      { type: "input_image", detail: "auto", image_url: "data:image/png;base64,aGVsbG8=" },
      { type: "input_text", text: "image content omitted because its source is not available to Codex" }
    ]
  }]);
});

test("repeated assistant text receives unique Responses item IDs", () => {
  const converted = convertMessages([
    { role: "assistant", content: "Done" },
    { role: "user", content: "Again" },
    { role: "assistant", content: "Done" }
  ]);
  const first = converted.input[0] as Record<string, unknown>;
  const second = converted.input[2] as Record<string, unknown>;
  assert.notEqual(first["id"], second["id"]);
});

test("request identity carries routed model, effort, and prompt cache key", () => {
  const body = buildRequest(
    [{ role: "system", content: "system" }, { role: "user", content: "hello" }],
    [],
    { model: "gpt-5.6-sol", reasoningEffort: "high", workload: "agent", agentId: "agent-a" },
    "grok:agent-a:agent"
  );
  assert.equal(body.model, "gpt-5.6-sol");
  assert.equal(body["prompt_cache_key"], "grok:agent-a:agent");
  assert.deepEqual(body["reasoning"], { effort: "high", summary: "auto" });
  assert.deepEqual(body["client_metadata"], {
    session_id: "grok:agent-a:agent",
    thread_id: "grok:agent-a:agent"
  });
});

test("GPT-5.6 reasoning uses the Codex effort contract", () => {
  const request = (reasoningEffort: "off" | "none" | "minimal") => buildRequest(
    [{ role: "user", content: "hello" }],
    [],
    { model: "gpt-5.6-sol", reasoningEffort, workload: "agent", agentId: "agent-a" },
    "grok:agent-a:agent"
  );
  assert.equal(request("off")["reasoning"], undefined);
  assert.deepEqual(request("none")["reasoning"], { effort: "none", summary: "auto" });
  assert.deepEqual(request("minimal")["reasoning"], { effort: "low", summary: "auto" });
});

test("Responses events preserve tool identity and provider cache usage", () => {
  const accumulator = new ResponseAccumulator();
  const parts: Array<Record<string, unknown> & { type: string }> = [];
  const push = (part: Record<string, unknown> & { type: string }) => parts.push(part);
  accumulator.consume({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", call_id: "call_1", name: "Check" }
  }, push);
  accumulator.consume({
    type: "response.function_call_arguments.delta",
    output_index: 0,
    delta: '{"value":"OK"}'
  }, push);
  accumulator.consume({
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call", call_id: "call_1", name: "Check", arguments: '{"value":"OK"}' }
  }, push);
  accumulator.consume({
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        input_tokens_details: { cached_tokens: 80 }
      }
    }
  }, push);
  const result = accumulator.result("gpt-5.6-sol", "test", parts);
  const call = result.parts.find((part) => part.type === "tool-call");
  assert.deepEqual(call, {
    type: "tool-call",
    toolCallId: "call_1",
    toolName: "Check",
    args: { value: "OK" }
  });
  const messages = result.response["messages"] as unknown[];
  const next = convertMessages([
    ...messages,
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_1", result: "done" }]
    }
  ]);
  assert.equal((next.input[0] as Record<string, unknown>)["call_id"], "call_1");
  assert.equal((next.input[1] as Record<string, unknown>)["call_id"], "call_1");
  assert.equal(result.extendedUsage.inputTokens, 20);
  assert.equal(result.extendedUsage.cacheReadTokens, 80);
  const reported = reportContextWindow({
    ...result,
    transport: "websocket",
    continuation: "delta",
    socketReused: true
  }, 872_000);
  assert.equal(reported.extendedUsage.maxTokens, 872_000);
  assert.equal(result.extendedUsage.maxTokens, 0);
});
