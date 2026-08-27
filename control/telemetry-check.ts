import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelemetryStore } from "./telemetry.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-router-telemetry-"));
process.env.SAND_DATA_ROOT = root;
const log = path.join(root, "grok-codex-router.log");
const events = [
  { ts: "2026-01-01T00:00:00.000Z", type: "usage", model: "old-model", inputTokens: 20, cachedInputTokens: 80, outputTokens: 5 },
  { ts: "2026-01-01T00:00:01.000Z", type: "turn", agentId: "agent-a", model: "new-model", inputTokens: 10, cachedInputTokens: 90, outputTokens: 7, durationMs: 1000 }
];
fs.writeFileSync(log, events.map((event) => JSON.stringify(event)).join("\n") + "\n");

const store = new TelemetryStore();
const first = store.snapshot();
assert.equal(first.summary.turns, 2);
assert.equal(first.summary.inputTokens, 30);
assert.equal(first.summary.cachedInputTokens, 170);
assert.equal(first.summary.outputTokens, 12);
assert.equal(first.byAgent.find((entry) => entry.agentId === "agent-a")?.model, "new-model");

fs.appendFileSync(log, JSON.stringify({
  ts: "2026-01-01T00:00:02.000Z",
  type: "turn",
  agentId: "agent-a",
  model: "new-model",
  inputTokens: 4,
  cachedInputTokens: 96,
  outputTokens: 3
}) + "\n");
const second = store.snapshot();
assert.equal(second.summary.turns, 3);
assert.equal(second.summary.inputTokens, 34);
assert.equal(second.summary.cachedInputTokens, 266);

fs.writeFileSync(log, JSON.stringify({
  ts: "2026-01-01T00:00:03.000Z",
  type: "turn",
  agentId: "agent-b",
  model: "new-model",
  inputTokens: 2,
  cachedInputTokens: 8,
  outputTokens: 1
}) + "\n");
const afterTruncate = store.snapshot();
assert.equal(afterTruncate.summary.turns, 4);
assert.equal(afterTruncate.summary.inputTokens, 36);
assert.equal(afterTruncate.summary.cachedInputTokens, 274);
store.close();

fs.rmSync(root, { recursive: true, force: true });
console.log("control telemetry ingestion OK");
