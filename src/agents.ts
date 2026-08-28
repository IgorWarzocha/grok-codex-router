import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GrokAgent {
  id: string;
  name: string;
}

export interface GrokProfile extends GrokAgent {
  kind: "agent" | "room";
}

function agentsRoot(): string {
  return path.join(process.env.SAND_DATA_ROOT || path.join(os.homedir(), "sand-data"), "agents");
}

export function discoverProfiles(root = agentsRoot()): GrokProfile[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((id) => {
    const directory = path.join(root, id);
    const file = path.join(directory, "profile.json");
    try {
      const profile = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (!profile || typeof profile !== "object" || !("name" in profile) || typeof profile.name !== "string") {
        return [];
      }
      // Sand stores chat rooms beside agents and marks each room with group.json.
      const kind: GrokProfile["kind"] = fs.existsSync(path.join(directory, "group.json")) ? "room" : "agent";
      return [{ id, name: profile.name, kind }];
    } catch {
      return [];
    }
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export function discoverAgents(root = agentsRoot()): GrokAgent[] {
  return discoverProfiles(root)
    .filter((profile) => profile.kind === "agent")
    .map(({ id, name }) => ({ id, name }));
}

export function resolveAgent(value: string, available = discoverAgents()): GrokAgent {
  const normalized = value.toLocaleLowerCase();
  const matches = available.filter((agent) =>
    agent.id === value || agent.name.toLocaleLowerCase() === normalized
  );
  if (matches.length !== 1) throw new Error("agent must match one immutable ID or profile name");
  return matches[0]!;
}
