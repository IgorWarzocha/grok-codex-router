import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAgents, discoverProfiles, resolveAgent } from "../src/agents.js";

function profile(root: string, id: string, name: string, room = false): void {
  const directory = path.join(root, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "profile.json"), JSON.stringify({ name }));
  if (room) fs.writeFileSync(path.join(directory, "group.json"), JSON.stringify({ version: 1, memberIds: [] }));
}

test("agent discovery excludes room profiles while routing resolves immutable IDs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-router-agents-"));
  try {
    profile(root, "id-b", "Archive");
    profile(root, "id-a", "Primary");
    profile(root, "room", "Studio", true);
    fs.mkdirSync(path.join(root, "broken"), { recursive: true });
    fs.writeFileSync(path.join(root, "broken", "profile.json"), "{");

    assert.deepEqual(discoverProfiles(root), [
      { id: "id-b", name: "Archive", kind: "agent" },
      { id: "id-a", name: "Primary", kind: "agent" },
      { id: "room", name: "Studio", kind: "room" }
    ]);
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
