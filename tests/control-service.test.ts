import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stopControlService } from "../src/control-service.js";

test("service stop repairs migrated permissions and stale PID state", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grok-codex-router-data-"));
  const previousDataRoot = process.env.SAND_DATA_ROOT;
  process.env.SAND_DATA_ROOT = dataRoot;
  try {
    const serviceRoot = path.join(dataRoot, "grok-codex-router-service");
    fs.mkdirSync(serviceRoot, { mode: 0o755 });
    fs.chmodSync(serviceRoot, 0o755);
    for (const file of ["supervisor.pid", "supervisor.lock", "control.pid"]) {
      fs.writeFileSync(path.join(serviceRoot, file), "999999");
    }

    const status = await stopControlService();

    assert.equal(status.running, false);
    assert.equal(fs.statSync(serviceRoot).mode & 0o077, 0);
    for (const file of ["supervisor.pid", "supervisor.lock", "control.pid"]) {
      assert.equal(fs.existsSync(path.join(serviceRoot, file)), false);
    }
  } finally {
    if (previousDataRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousDataRoot;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
