import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SandSupervisorStatus {
  updatedAtMs: number;
  hostBundlePresent: boolean;
  hostRunning: boolean;
  hostVersion: string | null;
  pendingUpgradeVersion: string | null;
  lastCommandId: string | null;
  lastCommandKind: string | null;
}

interface RestartOptions {
  reason: string;
  timeoutMs?: number;
}

function supervisorRoot(): string {
  return process.env.SAND_SUPERVISOR_DIR || "/tmp/sand-supervisor";
}

function dataRoot(): string {
  return process.env.SAND_DATA_ROOT || path.join(os.homedir(), "sand-data");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readSupervisorStatus(): SandSupervisorStatus {
  const file = path.join(supervisorRoot(), "status.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!isRecord(raw) || typeof raw["updatedAtMs"] !== "number" ||
      typeof raw["hostBundlePresent"] !== "boolean" || typeof raw["hostRunning"] !== "boolean") {
    throw new Error("Sand supervisor status has an unfamiliar shape");
  }
  const nullableString = (value: unknown): string | null => typeof value === "string" ? value : null;
  return {
    updatedAtMs: raw["updatedAtMs"],
    hostBundlePresent: raw["hostBundlePresent"],
    hostRunning: raw["hostRunning"],
    hostVersion: nullableString(raw["hostVersion"]),
    pendingUpgradeVersion: nullableString(raw["pendingUpgradeVersion"]),
    lastCommandId: nullableString(raw["lastCommandId"]),
    lastCommandKind: nullableString(raw["lastCommandKind"])
  };
}

export function supervisorReady(): boolean {
  try {
    return Date.now() - readSupervisorStatus().updatedAtMs < 30000;
  } catch {
    return false;
  }
}

function gatewayIdentity(): string {
  const file = path.join(dataRoot(), "gateway.json");
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isRecord(value)) return String(fs.statSync(file).mtimeMs);
    return [value["pid"], value["startedAt"], fs.statSync(file).mtimeMs].join(":");
  } catch {
    return "missing";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandPath(): string {
  return path.join(supervisorRoot(), "command.json");
}

export function supervisorHasPendingCommand(): boolean {
  return fs.existsSync(commandPath());
}

export async function requestHostRestart(options: RestartOptions): Promise<string> {
  if (!supervisorReady()) throw new Error("Sand supervisor is offline");
  if (supervisorHasPendingCommand()) throw new Error("Sand supervisor already has a pending command");
  const previousGatewayIdentity = gatewayIdentity();
  const id = "grok-codex-router-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex");
  const command = {
    id,
    kind: "restart",
    issuedAtMs: Date.now(),
    reason: options.reason
  };
  const file = commandPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(command) + "\n", { mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(temporary, file);
  } catch (error: unknown) {
    try { fs.unlinkSync(temporary); } catch {}
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("Sand supervisor received another command first");
    }
    throw error;
  }
  fs.unlinkSync(temporary);

  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60 * 1000);
  const ack = path.join(supervisorRoot(), "acks", id);
  let acknowledged = false;
  while (Date.now() < deadline) {
    if (fs.existsSync(ack)) acknowledged = true;
    if (acknowledged && gatewayIdentity() !== previousGatewayIdentity) {
      const status = readSupervisorStatus();
      if (status.hostRunning) return id;
    }
    await sleep(500);
  }
  throw new Error("Sand supervisor did not complete restart " + id + " before the timeout");
}
