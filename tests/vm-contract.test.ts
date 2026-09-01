import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAgents } from "../src/agents.js";
import { configPath, loadConfig } from "../src/config.js";
import { controlServiceStatus } from "../src/control-service.js";
import { credentialStatus } from "../src/oauth.js";
import { readSupervisorStatus } from "../src/sand-supervisor.js";

const routerHome = path.resolve(__dirname, "..", "..");
const dataRoot = process.env.SAND_DATA_ROOT || path.join(os.homedir(), "sand-data");
const hostDir = process.env.SAND_HOST_DIR || path.join(os.homedir(), "sand-host");

function privateMode(file: string): void {
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(
    mode & 0o077,
    0,
    `${file} is accessible to group or other users, mode ${mode.toString(8)}`
  );
}

test("the live Sand host accepts the compiled patch without mutation", () => {
  const host = path.join(hostDir, "host-main.cjs");
  assert.ok(fs.existsSync(host), `missing Sand host bundle at ${host}`);
  assert.ok(
    fs.existsSync(path.join(routerHome, "dist", "src", "session.js")),
    "missing compiled router session entry"
  );

  const result = spawnSync(
    process.execPath,
    [path.join(routerHome, "dist", "scripts", "patch-host.js"), "--check"],
    { cwd: routerHome, encoding: "utf8" }
  );
  assert.equal(
    result.status,
    0,
    ["live Sand host is incompatible with this router", result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
  );

  const source = fs.readFileSync(host, "utf8");
  const sessionMarkers = source.split("GROK_CODEX_ROUTER_SESSION_START").length - 1;
  const serviceMarkers = source.split("GROK_CODEX_ROUTER_SERVICE_START").length - 1;
  assert.ok(
    (sessionMarkers === 0 && serviceMarkers === 0) ||
    (sessionMarkers === 1 && serviceMarkers === 1),
    `host has a partial router patch, session markers ${sessionMarkers}, service markers ${serviceMarkers}`
  );
  if (sessionMarkers === 1) {
    assert.ok(
      fs.existsSync(path.join(hostDir, "host-main.cjs.grok-codex-router-bak")),
      "patched host is missing its pristine backup"
    );
  }
});

test("the package root exposes exactly the host bootstrap surface", () => {
  const loaded = createRequire(__filename)(routerHome) as Record<string, unknown>;
  assert.equal(typeof loaded["createCodexRouterSession"], "function");
  assert.equal(typeof loaded["isCodexRouterEnabled"], "function");
  assert.equal(typeof loaded["ensureControlService"], "function");
});

test("the live VM supplies Sand supervision, Bun, and discoverable agents", () => {
  const supervisor = readSupervisorStatus();
  assert.equal(supervisor.hostBundlePresent, true, "Sand supervisor cannot see the host bundle");
  assert.equal(supervisor.hostRunning, true, "Sand supervisor reports the host stopped");
  assert.ok(
    Date.now() - supervisor.updatedAtMs < 30_000,
    `Sand supervisor status is stale by ${Date.now() - supervisor.updatedAtMs}ms`
  );

  const bun = spawnSync("/usr/local/bin/bun", ["--version"], { encoding: "utf8" });
  assert.equal(bun.status, 0, `Bun is unavailable: ${bun.stderr.trim()}`);
  const [bunMajor, bunMinor] = bun.stdout.trim().split(".").map(Number);
  assert.ok(
    Number.isInteger(bunMajor) && Number.isInteger(bunMinor) &&
      (bunMajor! > 1 || (bunMajor === 1 && bunMinor! >= 4)),
    `Bun 1.4 or newer is required, found ${bun.stdout.trim()}`
  );

  const agents = discoverAgents();
  assert.ok(agents.length > 0, `no Grok Bot profiles were discovered under ${dataRoot}`);
  assert.equal(new Set(agents.map((agent) => agent.id)).size, agents.length, "Grok Bot profile IDs are not unique");
});

test("live router state and OAuth stores remain private local files", async () => {
  const configFile = configPath();
  if (fs.existsSync(configFile)) {
    loadConfig();
    privateMode(configFile);
  }

  const availableStores = (["pi", "codex"] as const).flatMap((store) => {
    try {
      const status = credentialStatus(store);
      privateMode(status.file);
      return status.accountIdPresent ? [store] : [];
    } catch {
      return [];
    }
  });
  assert.ok(availableStores.length > 0, "no readable local OpenAI OAuth store has an account identity");

  for (const entry of fs.readdirSync(dataRoot)) {
    if (!entry.startsWith("grok-codex-router")) continue;
    privateMode(path.join(dataRoot, entry));
  }

  const service = controlServiceStatus();
  assert.match(service.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const supervisorPid = path.join(dataRoot, "grok-codex-router-service", "supervisor.pid");
  if (fs.existsSync(supervisorPid)) {
    assert.equal(service.running, true, "router control supervisor has a stale or foreign PID file");
    const response = await fetch(service.url);
    assert.equal(response.status, 200, `control UI returned HTTP ${response.status}`);
    assert.match(response.headers.get("content-security-policy") || "", /default-src 'self'/);
  }
});
