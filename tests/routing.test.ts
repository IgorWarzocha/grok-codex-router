import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, resolveRoute, validateConfig } from "../src/config.js";
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
  const root = "grok:agent-a:agent";
  assert.equal(executorSessionIdFor(root, 0), root);
  assert.equal(executorSessionIdFor(root, 1), root + ":aux:1");
  assert.notEqual(executorSessionIdFor(root, 2), executorSessionIdFor(root, 1));
});
