import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAgents, resolveAgent } from "../src/agents.js";

function profile(root: string, id: string, name: string): void {
  const directory = path.join(root, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "profile.json"), JSON.stringify({ name }));
}

test("agent discovery follows live profiles while routing resolves immutable IDs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-router-agents-"));
  try {
    profile(root, "id-b", "Archive");
    profile(root, "id-a", "Primary");
    fs.mkdirSync(path.join(root, "broken"), { recursive: true });
    fs.writeFileSync(path.join(root, "broken", "profile.json"), "{");

    const agents = discoverAgents(root);
    assert.deepEqual(agents, [
      { id: "id-b", name: "Archive" },
      { id: "id-a", name: "Primary" }
    ]);
    assert.deepEqual(resolveAgent("primary", agents), { id: "id-a", name: "Primary" });
    assert.deepEqual(resolveAgent("id-b", agents), { id: "id-b", name: "Archive" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous profile names never select an arbitrary agent", () => {
  assert.throws(() => resolveAgent("same", [
    { id: "one", name: "Same" },
    { id: "two", name: "same" }
  ]), /one immutable ID or profile name/);
});
