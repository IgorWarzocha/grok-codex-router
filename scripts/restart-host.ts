#!/usr/bin/env node
import { requestHostRestart } from "../src/sand-supervisor.js";

async function main(): Promise<void> {
  const id = await requestHostRestart({ reason: "grok-codex-router requested restart" });
  console.log("Sand supervisor restart complete: " + id);
}

main().catch((error: unknown) => {
  console.error("ERROR: " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
