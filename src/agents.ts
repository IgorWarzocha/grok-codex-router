import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GrokAgent {
  id: string;
  name: string;
}

export function agentsRoot(): string {
  return path.join(process.env.SAND_DATA_ROOT || path.join(os.homedir(), "sand-data"), "agents");
}

export function discoverAgents(root = agentsRoot()): GrokAgent[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((id) => {
    const file = path.join(root, id, "profile.json");
    try {
      const profile = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (!profile || typeof profile !== "object" || !("name" in profile) || typeof profile.name !== "string") {
        return [];
      }
      return [{ id, name: profile.name }];
    } catch {
      return [];
    }
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export function resolveAgent(value: string, available = discoverAgents()): GrokAgent {
  const normalized = value.toLocaleLowerCase();
  const matches = available.filter((agent) =>
    agent.id === value || agent.name.toLocaleLowerCase() === normalized
  );
  if (matches.length !== 1) throw new Error("agent must match one immutable ID or profile name");
  return matches[0]!;
}
