import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function eventLogPath(): string {
  return process.env.SAND_CODEX_ROUTER_LOG ||
    path.join(
      process.env.SAND_DATA_ROOT || path.join(os.homedir(), "sand-data"),
      "grok-codex-router.log"
    );
}

export function recordEvent(event: Record<string, unknown>): void {
  try {
    const file = eventLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
  } catch {}
}
