import assert from "node:assert/strict";
import test from "node:test";
import {
  contextWindowForModel,
  DEFAULT_CONFIG,
  parseContextWindow,
  resolveRoute,
  validateConfig
} from "../src/config.js";
import { executorSessionIdFor } from "../src/session.js";

test("root agents route by immutable ID while workload classes stay explicit", () => {
  const config = validateConfig({
    ...structuredClone(DEFAULT_CONFIG),
    agents: {
      "agent-a": { model: "gpt-5.6-sol", reasoningEffort: "xhigh" }
    }
  });

  assert.deepEqual(resolveRoute(config, { conversationId: "agent-a" }), {
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    workload: "agent",
    agentId: "agent-a"
  });
  assert.deepEqual(resolveRoute(config, {
    conversationId: "agent-a",
    isSummarizationSession: true
  }), {
    ...config.classes.summarization,
    workload: "summarization",
    agentId: "agent-a"
  });
  assert.deepEqual(resolveRoute(config, {
    conversationId: "agent-a",
    requestSource: "automation"
  }), {
    ...config.classes.automation,
    workload: "automation",
    agentId: "agent-a"
  });
});

test("auxiliary executors cannot replace the root turn continuation lane", () => {
  const root = "grok:" + "a".repeat(59);
  assert.equal(executorSessionIdFor(root, 0), root);
  assert.equal(executorSessionIdFor(root, 1).length, 64);
  assert.match(executorSessionIdFor(root, 1), /:aux:1$/);
  assert.notEqual(executorSessionIdFor(root, 2), executorSessionIdFor(root, 1));
  assert.notEqual(executorSessionIdFor(root, 1), root);
});

test("each model owns one supported effective context budget", () => {
  assert.equal(parseContextWindow("272k"), 272_000);
  assert.equal(parseContextWindow("472000"), 472_000);
  assert.equal(parseContextWindow(872_000), 872_000);
  assert.throws(() => parseContextWindow("1m"), /272000, 472000, or 872000/);

  const config = validateConfig({
    ...structuredClone(DEFAULT_CONFIG),
    contextWindows: {
      "gpt-5.6-sol": 272_000,
      "gpt-5.6-luna": 472_000,
      "gpt-5.6-terra": 872_000
    }
  });
  assert.equal(contextWindowForModel(config, "gpt-5.6-sol"), 272_000);
  assert.equal(contextWindowForModel(config, "gpt-5.6-luna"), 472_000);
  assert.equal(contextWindowForModel(config, "gpt-5.6-terra"), 872_000);
  assert.equal(contextWindowForModel(config, "unknown-model"), 272_000);

  const { contextWindows: _omitted, ...priorConfig } = structuredClone(DEFAULT_CONFIG);
  const converted = validateConfig({ ...priorConfig, contextWindowTokens: 472_000 });
  assert.deepEqual(Object.values(converted.contextWindows), [472_000, 472_000, 472_000]);
});
