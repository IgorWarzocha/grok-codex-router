#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const routerHome = process.env.SAND_CODEX_ROUTER_HOME || path.resolve(__dirname, "..", "..");
const root = path.join(process.env.SAND_DATA_ROOT || path.join(os.homedir(), "sand-data"), "grok-codex-router-service");
const lockFile = path.join(root, "supervisor.lock");
const pidFile = path.join(root, "supervisor.pid");
const childPidFile = path.join(root, "control.pid");
const serverEntry = path.join(routerHome, "dist", "control", "server.js");
const bun = process.env.SAND_CODEX_ROUTER_BUN || "/usr/local/bin/bun";
const logFile = process.env.SAND_CODEX_ROUTER_SERVICE_LOG || "/tmp/grok-codex-router-service.log";

function liveOwner(file: string): boolean {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    process.kill(pid, 0);
    return fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").includes(__filename);
  } catch {
    return false;
  }
}

fs.mkdirSync(root, { recursive: true, mode: 0o700 });
if (!fs.existsSync(serverEntry)) throw new Error("missing control server " + serverEntry);
if (fs.existsSync(lockFile)) {
  if (liveOwner(lockFile)) process.exit(0);
  fs.unlinkSync(lockFile);
}
fs.writeFileSync(lockFile, String(process.pid), { mode: 0o600, flag: "wx" });
fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });

let stopping = false;
let child: ChildProcess | undefined;
const stop = () => {
  stopping = true;
  if (child?.pid) {
    try { process.kill(child.pid, "SIGTERM"); } catch {}
  }
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(): Promise<void> {
  let failures = 0;
  while (!stopping) {
    const started = Date.now();
    const log = fs.openSync(logFile, "a", 0o600);
    child = spawn(bun, [serverEntry], {
      cwd: routerHome,
      env: process.env,
      stdio: ["ignore", log, log]
    });
    fs.closeSync(log);
    if (child.pid) fs.writeFileSync(childPidFile, String(child.pid), { mode: 0o600 });
    await new Promise<void>((resolve) => child?.once("close", () => resolve()));
    try { fs.unlinkSync(childPidFile); } catch {}
    if (stopping) break;
    failures = Date.now() - started > 60000 ? 0 : failures + 1;
    await wait(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)));
  }
}

run().finally(() => {
  try { fs.unlinkSync(childPidFile); } catch {}
  try { fs.unlinkSync(pidFile); } catch {}
  try { fs.unlinkSync(lockFile); } catch {}
});
