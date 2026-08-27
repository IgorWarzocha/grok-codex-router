import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readSupervisorStatus, requestHostRestart, supervisorHasPendingCommand } from "../src/sand-supervisor.js";

export type ReconcilePhase = "starting" | "healthy" | "checking" | "patching" | "waiting" | "restarting" | "incompatible" | "error";

export interface ReconcileState {
  phase: ReconcilePhase;
  message: string;
  checkedAt: string;
  hostVersion: string;
  hostFingerprint: string;
  restartRequired: boolean;
}

interface PatchResult {
  ok: boolean;
  detail: string;
}

function routerHome(): string {
  return process.env.SAND_CODEX_ROUTER_HOME || path.resolve(__dirname, "..", "..");
}

function hostPath(): string {
  return path.join(process.env.SAND_HOST_DIR || path.join(os.homedir(), "sand-host"), "host-main.cjs");
}

function statePath(): string {
  return path.join(process.env.SAND_DATA_ROOT || path.join(os.homedir(), "sand-data"), "grok-codex-router-recovery.json");
}

function version(): string {
  try { return fs.readFileSync(path.join(path.dirname(hostPath()), "version"), "utf8").trim() || "unknown"; }
  catch { return "unknown"; }
}

function readSource(): { source: string; fingerprint: string } {
  const source = fs.readFileSync(hostPath(), "utf8");
  return {
    source,
    fingerprint: crypto.createHash("sha256").update(source).digest("hex").slice(0, 16)
  };
}

function hostStamp(): string {
  const stat = fs.statSync(hostPath());
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, version()].join(":");
}

function runPatcher(checkOnly: boolean): Promise<PatchResult> {
  return new Promise((resolve) => {
    const script = path.join(routerHome(), "dist", "scripts", "patch-host.js");
    const child = spawn(process.execPath, [script, ...(checkOnly ? ["--check"] : [])], {
      cwd: routerHome(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output = (output + chunk.toString()).slice(-8192); });
    child.stderr?.on("data", (chunk) => { output = (output + chunk.toString()).slice(-8192); });
    child.once("exit", (code) => {
      const detail = output.split("\n").map((line) => line.trim()).filter(Boolean).slice(-3).join(" | ");
      resolve({ ok: code === 0, detail: detail || "patcher exited without output" });
    });
    child.once("error", (error) => resolve({ ok: false, detail: error.message }));
  });
}

function initialState(): ReconcileState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8")) as Partial<ReconcileState>;
    if (typeof parsed.restartRequired === "boolean") {
      return {
        phase: parsed.phase || "starting",
        message: parsed.message || "Starting recovery monitor.",
        checkedAt: parsed.checkedAt || new Date().toISOString(),
        hostVersion: parsed.hostVersion || "unknown",
        hostFingerprint: parsed.hostFingerprint || "",
        restartRequired: parsed.restartRequired
      };
    }
  } catch {}
  return {
    phase: "starting",
    message: "Starting recovery monitor.",
    checkedAt: new Date().toISOString(),
    hostVersion: "unknown",
    hostFingerprint: "",
    restartRequired: false
  };
}

export class HostReconciler {
  private state = initialState();
  private active: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastStamp = "";

  snapshot(): ReconcileState {
    return { ...this.state };
  }

  private publish(update: Partial<ReconcileState>): void {
    this.state = { ...this.state, ...update, checkedAt: new Date().toISOString() };
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + "." + process.pid + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  }

  start(): void {
    void this.reconcile(true);
    this.timer = setInterval(() => { void this.reconcile(false); }, 5000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  reconcile(force: boolean): Promise<void> {
    if (this.active) return this.active;
    this.active = this.run(force).finally(() => { this.active = undefined; });
    return this.active;
  }

  private async run(force: boolean): Promise<void> {
    let current;
    let stamp;
    try {
      stamp = hostStamp();
      if (!force && stamp === this.lastStamp && !this.state.restartRequired) return;
      current = readSource();
    } catch (error: unknown) {
      this.publish({ phase: "error", message: "Cannot read Sand host: " + (error instanceof Error ? error.message : String(error)) });
      return;
    }
    const hostVersion = version();
    try {
      const supervisor = readSupervisorStatus();
      if (supervisor.pendingUpgradeVersion || supervisorHasPendingCommand()) {
        this.publish({
          phase: "waiting",
          message: "Waiting for Sand supervisor to finish its current operation.",
          hostVersion
        });
        return;
      }
    } catch {
      this.publish({ phase: "error", message: "Sand supervisor is unavailable.", hostVersion });
      return;
    }

    if (this.state.restartRequired) {
      await this.restartPatchedHost(hostVersion, current.fingerprint);
      return;
    }

    this.publish({ phase: "checking", message: "Checking host compatibility.", hostVersion });
    const check = await runPatcher(true);
    if (!check.ok) {
      this.publish({
        phase: "incompatible",
        message: check.detail,
        hostVersion,
        hostFingerprint: current.fingerprint,
        restartRequired: false
      });
      this.lastStamp = stamp;
      return;
    }
    const sessionInstalled = current.source.includes("GROK_CODEX_ROUTER_SESSION_START");
    const serviceInstalled = current.source.includes("GROK_CODEX_ROUTER_SERVICE_START");
    if (sessionInstalled && serviceInstalled) {
      this.publish({
        phase: "healthy",
        message: "Host patch is installed and compatible.",
        hostVersion,
        hostFingerprint: current.fingerprint,
        restartRequired: false
      });
      this.lastStamp = stamp;
      return;
    }

    this.publish({ phase: "patching", message: "Compatible host update detected. Applying router patch.", hostVersion });
    const patch = await runPatcher(false);
    if (!patch.ok) {
      this.publish({
        phase: "incompatible",
        message: patch.detail,
        hostVersion,
        hostFingerprint: current.fingerprint,
        restartRequired: false
      });
      this.lastStamp = stamp;
      return;
    }
    const patched = readSource();
    this.lastStamp = hostStamp();
    this.publish({
      phase: "restarting",
      message: "Patch installed. Waiting for an idle native host restart.",
      hostVersion,
      hostFingerprint: patched.fingerprint,
      restartRequired: true
    });
    await this.restartPatchedHost(hostVersion, patched.fingerprint);
  }

  private async restartPatchedHost(hostVersion: string, fingerprint: string): Promise<void> {
    this.publish({
      phase: "restarting",
      message: "Waiting for an idle native host restart.",
      hostVersion,
      hostFingerprint: fingerprint,
      restartRequired: true
    });
    try {
      await requestHostRestart({ reason: "grok-codex-router automatic compatible-host recovery" });
      const current = readSource();
      this.lastStamp = hostStamp();
      this.publish({
        phase: "healthy",
        message: "Host patch is installed and loaded.",
        hostVersion: version(),
        hostFingerprint: current.fingerprint,
        restartRequired: false
      });
    } catch (error: unknown) {
      this.publish({
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
        hostVersion,
        hostFingerprint: fingerprint,
        restartRequired: true
      });
    }
  }
}
