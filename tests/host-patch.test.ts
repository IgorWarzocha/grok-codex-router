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
    'function createCursorInferencePromptSession() { return { provider: "native" }; }',
    "async function createSession(onRequestId, sessionOptions) {",
    '      const requestedModel = "native-model";',
    "      const session = createCursorInferencePromptSession({",
    "        requestedModel",
    "      });",
    "      return session;",
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
    "module.exports = createSession;",
    ""
  ].join("\n");
}

function previousRouterHook(): string {
  return [
    "      /* GROK_CODEX_ROUTER_SESSION_START */",
    '      const inferenceProvider = (process.env.SAND_INFERENCE_PROVIDER || "codex-router").toLowerCase();',
    '      if (inferenceProvider !== "cursor") {',
    '        const routerHome = process.env.SAND_CODEX_ROUTER_HOME || require("path").join(require("os").homedir(), "grok-codex-router");',
    '        const { createCodexRouterSession } = require(routerHome);',
    "        return createCodexRouterSession({",
    "          requestedModel,",
    "          onRequestId,",
    "          sessionOptions",
    "        });",
    "      }",
    "      /* GROK_CODEX_ROUTER_SESSION_END */"
  ].join("\n");
}

function runPatcher(hostDir: string, ...args: string[]) {
  return spawnSync(process.execPath, [patcher, ...args], {
    env: { ...process.env, SAND_HOST_DIR: hostDir },
    encoding: "utf8"
  });
}

function runHostSession(hostFile: string, routerHome: string, enabled: boolean) {
  return spawnSync(process.execPath, [
    "-e",
    `Promise.resolve(require(${JSON.stringify(hostFile)})()).then((session) => console.log(session.provider))`
  ], {
    env: {
      ...process.env,
      SAND_CODEX_ROUTER_HOME: routerHome,
      TEST_CODEX_ROUTER_ENABLED: String(enabled)
    },
    encoding: "utf8"
  });
}

test("the current Sand summarization boundary patches idempotently", () => {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-router-host-"));
  const hostFile = path.join(hostDir, "host-main.cjs");
  const backupFile = hostFile + ".grok-codex-router-bak";
  const routerHome = path.join(hostDir, "router");
  const pristine = currentHostShape();
  try {
    fs.mkdirSync(routerHome);
    fs.writeFileSync(path.join(routerHome, "index.js"), [
      "module.exports.ensureControlService = () => {};",
      'module.exports.isCodexRouterEnabled = () => process.env.TEST_CODEX_ROUTER_ENABLED === "true";',
      'module.exports.createCodexRouterSession = () => ({ provider: "router" });',
      ""
    ].join("\n"));
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
    const nativeSession = runHostSession(hostFile, routerHome, false);
    assert.equal(nativeSession.status, 0, nativeSession.stderr);
    assert.equal(nativeSession.stdout.trim(), "native");
    const routerSession = runHostSession(hostFile, routerHome, true);
    assert.equal(routerSession.status, 0, routerSession.stderr);
    assert.equal(routerSession.stdout.trim(), "router");

    const recheck = runPatcher(hostDir, "--check");
    assert.equal(recheck.status, 0, recheck.stderr);
    assert.equal(fs.readFileSync(hostFile, "utf8"), patched);

    const hookStart = patched.indexOf("      /* GROK_CODEX_ROUTER_SESSION_START */");
    const hookEnd = patched.indexOf("/* GROK_CODEX_ROUTER_SESSION_END */", hookStart) +
      "/* GROK_CODEX_ROUTER_SESSION_END */".length;
    fs.writeFileSync(hostFile, patched.slice(0, hookStart) + previousRouterHook() + patched.slice(hookEnd));
    const upgrade = runPatcher(hostDir);
    assert.equal(upgrade.status, 0, upgrade.stderr);
    assert.equal(fs.readFileSync(hostFile, "utf8"), patched);
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
  }
});
