import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const patcher = path.resolve(__dirname, "..", "scripts", "patch-host.js");

function currentHostShape(): string {
  return [
    "const __mod=require('node:module');",
    '"use strict";',
    "async function createSession() {",
    "      const session = createCursorInferencePromptSession({",
    "        requestedModel",
    "      });",
    "        const mainSessionOptions = {",
    "          modelId: host.subagentModelId,",
    "          ...lineage != null ? { lineage } : {}",
    "        };",
    "        const summarizationSession = sanitizePromptSessionUsage(",
    "          host.inference.createSession(",
    "            emitRequestId,",
    "            {",
    "              modelId: SAND_SUMMARIZATION_MODEL_ID,",
    "              isSummarizationSession: true,",
    "              ...lineage != null ? { lineage } : {}",
    "            }",
    "          )",
    "        );",
    "        const turnStartedAtMs = Date.now();",
    "        const mcpTools = mcpDiscovery.tools;",
    "}",
    ""
  ].join("\n");
}

function runPatcher(hostDir: string, ...args: string[]) {
  return spawnSync(process.execPath, [patcher, ...args], {
    env: { ...process.env, SAND_HOST_DIR: hostDir },
    encoding: "utf8"
  });
}

test("the current Sand summarization boundary patches idempotently", () => {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-router-host-"));
  const hostFile = path.join(hostDir, "host-main.cjs");
  const backupFile = hostFile + ".grok-codex-router-bak";
  const pristine = currentHostShape();
  try {
    fs.writeFileSync(hostFile, pristine);

    const check = runPatcher(hostDir, "--check");
    assert.equal(check.status, 0, check.stderr);
    assert.equal(fs.readFileSync(hostFile, "utf8"), pristine);

    const install = runPatcher(hostDir);
    assert.equal(install.status, 0, install.stderr);
    const patched = fs.readFileSync(hostFile, "utf8");
    assert.equal(fs.readFileSync(backupFile, "utf8"), pristine);
    assert.equal(patched.split("GROK_CODEX_ROUTER_SESSION_START").length - 1, 1);
    assert.equal(patched.split("GROK_CODEX_ROUTER_SERVICE_START").length - 1, 1);
    assert.equal(patched.split("          conversationId,").length - 1, 2);

    const recheck = runPatcher(hostDir, "--check");
    assert.equal(recheck.status, 0, recheck.stderr);
    assert.equal(fs.readFileSync(hostFile, "utf8"), patched);
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
  }
});
