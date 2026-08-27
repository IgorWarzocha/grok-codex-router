#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { configPath, DEFAULT_CONFIG, loadConfig, writeConfig, type ReasoningEffort, type RouterConfig } from "../src/config.js";
import { credentialStatus } from "../src/oauth.js";
import { createCodexRouterSession, type PromptStreamResult } from "../src/session.js";
import { closeAll } from "../src/transport.js";

interface Agent {
  id: string;
  name: string;
}

function agents(): Agent[] {
  const root = path.join(process.env.SAND_DATA_ROOT || path.join(os.homedir(), "sand-data"), "agents");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((id) => {
    const file = path.join(root, id, "profile.json");
    try {
      const profile = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (!profile || typeof profile !== "object" || !("name" in profile) || typeof profile.name !== "string") return [];
      return [{ id, name: profile.name }];
    } catch {
      return [];
    }
  });
}

function resolveAgent(value: string): Agent {
  const normalized = value.toLocaleLowerCase();
  const matches = agents().filter((agent) =>
    agent.id === value || agent.name.toLocaleLowerCase() === normalized
  );
  if (matches.length !== 1) throw new Error("agent must match one immutable ID or profile name");
  return matches[0]!;
}

function runBuiltScript(name: string): void {
  const file = path.resolve(__dirname, "..", "scripts", name + ".js");
  const result = spawnSync(process.execPath, [file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function initialize(): string {
  const file = configPath();
  if (!fs.existsSync(file)) writeConfig(structuredClone(DEFAULT_CONFIG));
  return file;
}

function requireArgs(values: string[], count: number, usage: string): string[] {
  if (values.length < count) throw new Error("usage: " + usage);
  return values;
}

function setRoute(target: "default" | "agent" | "class", values: string[]): void {
  const config = loadConfig();
  if (target === "default") {
    const [model, reasoningEffort] = requireArgs(values, 2, "grok-codex-router default MODEL EFFORT");
    config.default = { model: model!, reasoningEffort: reasoningEffort as ReasoningEffort };
  } else if (target === "agent") {
    const [identity, model, reasoningEffort] = requireArgs(values, 3, "grok-codex-router route AGENT MODEL EFFORT");
    const agent = resolveAgent(identity!);
    config.agents[agent.id] = { model: model!, reasoningEffort: reasoningEffort as ReasoningEffort };
  } else {
    const [name, model, reasoningEffort] = requireArgs(values, 3, "grok-codex-router class CLASS MODEL EFFORT");
    if (!Object.hasOwn(config.classes, name!)) throw new Error("unknown workload class: " + name);
    config.classes[name! as keyof RouterConfig["classes"]] = {
      model: model!,
      reasoningEffort: reasoningEffort as ReasoningEffort
    };
  }
  console.log("wrote " + writeConfig(config));
}

function setAuthStore(value: string | undefined): void {
  if (value !== "pi" && value !== "codex") {
    throw new Error("usage: grok-codex-router auth-store pi|codex");
  }
  const config = loadConfig();
  credentialStatus(value);
  config.authStore = value;
  console.log("wrote " + writeConfig(config));
}

function printRoutes(): void {
  const config = loadConfig();
  console.log("default\t" + config.default.model + "\t" + config.default.reasoningEffort);
  for (const [name, route] of Object.entries(config.classes)) {
    console.log("class:" + name + "\t" + route.model + "\t" + route.reasoningEffort);
  }
  const names = new Map(agents().map((agent) => [agent.id, agent.name]));
  for (const [id, route] of Object.entries(config.agents)) {
    console.log((names.get(id) || id) + "\t" + route.model + "\t" + route.reasoningEffort + "\t" + id);
  }
}

async function collect(result: PromptStreamResult): Promise<{
  text: string;
  toolCalls: Array<Record<string, unknown>>;
}> {
  let text = "";
  const toolCalls: Array<Record<string, unknown>> = [];
  for await (const part of result.fullStream) {
    if (part["type"] === "error") throw part["error"];
    if (part["type"] === "text-delta") text += String(part["textDelta"] || "");
    if (part["type"] === "tool-call") toolCalls.push(part);
  }
  return { text, toolCalls };
}

async function verify(identity?: string): Promise<void> {
  const agent = identity ? resolveAgent(identity) : agents()[0];
  if (!agent) throw new Error("no Grok Bot agent profile found");
  const session = createCodexRouterSession({ sessionOptions: { conversationId: agent.id } });
  const executor = session.getExecutor([
    { role: "system", content: "You are a transport verifier." },
    { role: "user", content: 'Call Check exactly once with {"value":"ROUTER_OK"}. After its result, reply with only that result.' }
  ]);
  const tool = {
    name: "Check",
    description: "Return a verification value",
    parameters: {
      jsonSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false
      }
    }
  };
  const firstResult = executor.stream(undefined, "router-verify-1", [tool]);
  const first = await collect(firstResult);
  if (first.toolCalls.length !== 1) throw new Error("verification expected one Check tool call");
  const call = first.toolCalls[0]!;
  const firstResponse = await firstResult.response;
  executor.appendMessages(firstResponse["messages"]);
  executor.appendMessages({
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: call["toolCallId"],
      toolName: "Check",
      result: "ROUTER_OK"
    }]
  });
  const second = await collect(executor.stream(undefined, "router-verify-2", [tool]));
  if (second.text.trim() !== "ROUTER_OK") {
    throw new Error("verification reply mismatch: " + JSON.stringify(second.text));
  }
  console.log("direct Codex Responses tool round-trip OK");
}

function status(): void {
  const config = loadConfig();
  const auth = credentialStatus(config.authStore);
  const host = path.join(os.homedir(), "sand-host", "host-main.cjs");
  const patched = fs.existsSync(host) && fs.readFileSync(host, "utf8").includes("GROK_CODEX_ROUTER_SESSION_START");
  console.log("config\t" + configPath());
  console.log("auth\t" + auth.store + "\tvalid " + Math.floor(auth.validForMs / 60000) + "m");
  console.log("host patch\t" + (patched ? "installed" : "missing"));
  printRoutes();
}

function help(): void {
  console.log([
    "grok-codex-router",
    "",
    "  init",
    "  install",
    "  recover",
    "  status",
    "  routes",
    "  auth-store pi|codex",
    "  default MODEL EFFORT",
    "  route AGENT MODEL EFFORT",
    "  class CLASS MODEL EFFORT",
    "  patch-host",
    "  restart-host",
    "  verify [AGENT]"
  ].join("\n"));
}

async function main(): Promise<void> {
  const [command = "help", ...values] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") help();
  else if (command === "init") console.log("config ready: " + initialize());
  else if (command === "routes") printRoutes();
  else if (command === "auth-store") setAuthStore(values[0]);
  else if (command === "status") status();
  else if (command === "default") setRoute("default", values);
  else if (command === "route") setRoute("agent", values);
  else if (command === "class") setRoute("class", values);
  else if (command === "patch-host") runBuiltScript("patch-host");
  else if (command === "restart-host") runBuiltScript("restart-host");
  else if (command === "install" || command === "recover") {
    initialize();
    runBuiltScript("patch-host");
    runBuiltScript("restart-host");
  } else if (command === "verify") {
    try {
      await verify(values[0]);
    } finally {
      closeAll();
    }
  }
  else throw new Error("unknown command: " + command);
}

main().catch((error: unknown) => {
  console.error("ERROR: " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
