import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, ROUTER_MODELS } from "./config.js";
import { controlServiceStatus } from "./control-service.js";
import { credentialStatus } from "./oauth.js";
import { readSupervisorStatus } from "./sand-supervisor.js";

const ISSUE_URL = "https://github.com/IgorWarzocha/grok-codex-router/issues/new";

function routerHome(): string {
  return process.env.SAND_CODEX_ROUTER_HOME || path.resolve(__dirname, "..", "..");
}

function hostFile(): string {
  return path.join(process.env.SAND_HOST_DIR || path.join(os.homedir(), "sand-host"), "host-main.cjs");
}

function hostVersion(): string {
  try { return fs.readFileSync(path.join(path.dirname(hostFile()), "version"), "utf8").trim() || "unknown"; }
  catch { return "unknown"; }
}

function commandVersion(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim().split("\n")[0] || "unknown" : "unavailable";
}

function repositoryRevision(): string {
  const result = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: routerHome(),
    encoding: "utf8"
  });
  if (result.status !== 0) return "uncommitted";
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: routerHome(), encoding: "utf8" });
  return result.stdout.trim() + (status.stdout.trim() ? "+dirty" : "");
}

function patchCheck(): { status: string; detail: string } {
  const script = path.join(routerHome(), "dist", "scripts", "patch-host.js");
  const result = spawnSync(process.execPath, [script, "--check"], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024
  });
  const combined = (result.stdout + "\n" + result.stderr)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" | ");
  return { status: result.status === 0 ? "compatible" : "incompatible", detail: combined || "no patcher output" };
}

export function issueReport(): string {
  const host = hostFile();
  const source = fs.existsSync(host) ? fs.readFileSync(host) : Buffer.alloc(0);
  const text = source.toString("utf8");
  const config = loadConfig();
  const service = controlServiceStatus();
  const patch = patchCheck();
  let auth = "invalid or unavailable";
  try {
    const status = credentialStatus(config.authStore);
    auth = status.store + ", valid for " + Math.floor(status.validForMs / 60000) + " minutes";
  } catch {}
  let supervisor = "unavailable";
  try {
    const status = readSupervisorStatus();
    supervisor = [
      "hostRunning=" + status.hostRunning,
      "hostVersion=" + (status.hostVersion || "unknown"),
      "pendingUpgrade=" + (status.pendingUpgradeVersion || "none")
    ].join(", ");
  } catch {}
  return [
    "## Grok Codex Router compatibility report",
    "",
    "- Router revision: " + repositoryRevision(),
    "- Host version: " + hostVersion(),
    "- Host SHA-256: " + crypto.createHash("sha256").update(source).digest("hex"),
    "- Session markers: " + (text.split("GROK_CODEX_ROUTER_SESSION_START").length - 1),
    "- Service markers: " + (text.split("GROK_CODEX_ROUTER_SERVICE_START").length - 1),
    "- Patcher: " + patch.status,
    "- Patcher detail: " + patch.detail,
    "- Control service: " + (service.running ? "running" : "stopped"),
    "- Sand supervisor: " + supervisor,
    "- OAuth store health: " + auth,
    "- Context windows: " + ROUTER_MODELS.map((model) =>
      model.slice("gpt-5.6-".length) + "=" + config.contextWindows[model] / 1_000 + "k"
    ).join(", "),
    "- Node: " + process.version,
    "- Bun: " + commandVersion("/usr/local/bin/bun", ["--version"]),
    "- Platform: " + process.platform + " " + process.arch,
    "",
    "Expected issue destination: " + ISSUE_URL,
    "",
    "Do not attach the host bundle, OAuth files, prompts, tool arguments, or raw authorization data."
  ].join("\n");
}
