import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { controlUrl } from "./control-address.js";

export interface ControlServiceStatus {
  running: boolean;
  pid?: number | undefined;
  url: string;
  logFile: string;
}

function serviceRoot(): string {
  return path.join(process.env.SAND_DATA_ROOT || path.join(os.homedir(), "sand-data"), "grok-codex-router-service");
}

function ensurePrivateServiceRoot(): void {
  fs.mkdirSync(serviceRoot(), { recursive: true, mode: 0o700 });
  fs.chmodSync(serviceRoot(), 0o700);
}

function pidFile(): string {
  return path.join(serviceRoot(), "supervisor.pid");
}

function logFile(): string {
  return process.env.SAND_CODEX_ROUTER_SERVICE_LOG || "/tmp/grok-codex-router-service.log";
}

function supervisorEntry(): string {
  return path.resolve(__dirname, "..", "scripts", "supervise-control.js");
}

function readPid(): number | undefined {
  try {
    const pid = Number(fs.readFileSync(pidFile(), "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function ownsSupervisor(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const command = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8");
    return command.includes(supervisorEntry());
  } catch {
    return false;
  }
}

export function controlServiceStatus(): ControlServiceStatus {
  const pid = readPid();
  return {
    running: Boolean(pid && ownsSupervisor(pid)),
    ...(pid && ownsSupervisor(pid) ? { pid } : {}),
    url: controlUrl(),
    logFile: logFile()
  };
}

export function ensureControlService(): ControlServiceStatus {
  ensurePrivateServiceRoot();
  const current = controlServiceStatus();
  if (current.running) return current;
  try { fs.unlinkSync(pidFile()); } catch {}
  const log = fs.openSync(logFile(), "a", 0o600);
  const child = spawn(process.execPath, [supervisorEntry()], {
    cwd: path.resolve(__dirname, "..", ".."),
    detached: true,
    env: {
      ...process.env,
      SAND_CODEX_ROUTER_HOME: path.resolve(__dirname, "..", "..")
    },
    stdio: ["ignore", log, log]
  });
  child.unref();
  fs.closeSync(log);
  return {
    running: true,
    ...(child.pid ? { pid: child.pid } : {}),
    url: current.url,
    logFile: current.logFile
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function stopControlService(): Promise<ControlServiceStatus> {
  ensurePrivateServiceRoot();
  const current = controlServiceStatus();
  if (current.running && current.pid) {
    try { process.kill(current.pid, "SIGTERM"); } catch {}
    for (let attempt = 0; attempt < 20 && ownsSupervisor(current.pid); attempt++) {
      await sleep(100);
    }
    if (ownsSupervisor(current.pid)) {
      try { process.kill(current.pid, "SIGKILL"); } catch {}
    }
  }
  const replacement = controlServiceStatus();
  if (replacement.running && replacement.pid !== current.pid) return replacement;
  for (const file of ["supervisor.pid", "supervisor.lock", "control.pid"]) {
    try { fs.unlinkSync(path.join(serviceRoot(), file)); } catch {}
  }
  return controlServiceStatus();
}

export async function restartControlService(): Promise<ControlServiceStatus> {
  await stopControlService();
  return ensureControlService();
}
