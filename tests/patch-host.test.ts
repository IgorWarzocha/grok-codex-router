import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const routerHome = path.resolve(__dirname, "..", "..");
const patcher = path.join(routerHome, "dist", "scripts", "patch-host.js");
const oldEnd = "        let mcpTools = [];";
const currentEnd = "        const mcpDiscovery = await mcpToolsDiscovery;";

function checkHost(endAnchors: string[]): number | null {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-codex-router-host-"));
  try {
    fs.writeFileSync(path.join(hostDir, "host-main.cjs"), [
      "const __mod=require('node:module');",
      '"use strict";',
      "      const session = createCursorInferencePromptSession({",
      "        const mainSessionOptions = {",
      "          modelId: host.subagentModelId,",
      "        const summarizationSession = sanitizePromptSessionUsage(",
      "            {",
      "              modelId: SAND_SUMMARIZATION_MODEL_ID,",
      ...endAnchors,
    ].join("\n"));
    return spawnSync(process.execPath, [patcher, "--check"], {
      env: { ...process.env, SAND_HOST_DIR: hostDir },
      encoding: "utf8",
    }).status;
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
  }
}

test("the summarization boundary requires exactly one recognized end anchor", () => {
  assert.equal(checkHost([oldEnd]), 0);
  assert.equal(checkHost([currentEnd]), 0);
  assert.equal(checkHost([oldEnd, currentEnd]), 1);
  assert.equal(checkHost([oldEnd, oldEnd]), 1);
  assert.equal(checkHost([currentEnd, currentEnd]), 1);
});
