#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function processIds(): number[] {
  return fs.readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map(Number);
}

function commandLine(pid: number): string[] {
  try {
    return fs.readFileSync("/proc/" + pid + "/cmdline").toString("utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function processEnvironment(pid: number): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const raw = fs.readFileSync("/proc/" + pid + "/environ");
  for (const entry of raw.toString("utf8").split("\0")) {
    const separator = entry.indexOf("=");
    if (separator > 0) environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
}

async function main(): Promise<void> {
  const hostDir = process.env.SAND_HOST_DIR || path.join(os.homedir(), "sand-host");
  const hostFile = path.join(hostDir, "host-main.cjs");
  if (!fs.existsSync(hostFile)) throw new Error("missing " + hostFile);
  const gatewayFile = path.join(
    process.env.SAND_DATA_ROOT || path.join(os.homedir(), "sand-data"),
    "gateway.json"
  );
  const previousGatewayMtime = fs.existsSync(gatewayFile) ? fs.statSync(gatewayFile).mtimeMs : 0;

  const hostPids = processIds().filter((pid) => commandLine(pid).some((argument) => argument === hostFile));
  const donorPid = hostPids[0] ?? processIds().find((pid) => {
    const command = commandLine(pid);
    return command[0] === "/exec-daemon/node" && command.includes("/exec-daemon/index.js");
  });
  if (!donorPid) throw new Error("could not find a Sand host or exec-daemon process to supply the VM environment");

  const environment = processEnvironment(donorPid);
  environment["SAND_PACKAGED"] = "1";
  environment["SAND_HOST_IN_BOX"] = "1";
  environment["SAND_HOST_LOG_FILE"] = "/tmp/sand-host-manual.log";
  environment["SAND_DATA_ROOT"] = process.env.SAND_DATA_ROOT || environment["SAND_DATA_ROOT"] || path.join(os.homedir(), "sand-data");
  environment["SAND_INFERENCE_PROVIDER"] = "codex-router";
  environment["SAND_CODEX_ROUTER_HOME"] = path.resolve(__dirname, "..", "..");

  for (const pid of hostPids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const log = fs.openSync("/tmp/sand-host-manual.log", "a");
  fs.writeSync(log, "\n--- grok-codex-router restart ---\n");
  const child = spawn("/exec-daemon/node", [hostFile], {
    cwd: hostDir,
    env: environment,
    detached: true,
    stdio: ["ignore", log, log]
  });
  child.unref();
  fs.closeSync(log);
  console.log("spawned Sand host pid=" + child.pid);

  for (let attempt = 0; attempt < 30; attempt++) {
    const gateway = path.join(environment["SAND_DATA_ROOT"]!, "gateway.json");
    if (fs.existsSync(gateway) && fs.statSync(gateway).mtimeMs > previousGatewayMtime) {
      console.log("gateway ready: " + gateway);
      return;
    }
    if (child.exitCode !== null) throw new Error("Sand host exited before publishing gateway.json");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Sand host did not publish gateway.json");
}

main().catch((error: unknown) => {
  console.error("ERROR: " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
