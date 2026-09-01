#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { discoverAgents, discoverProfiles, resolveAgent } from "../src/agents.js";
import {
  configPath,
  DEFAULT_CONFIG,
  loadConfig,
  parseContextWindow,
  ROUTER_MODELS,
  writeConfig,
  type ReasoningEffort,
  type RouterModel,
  type RouterConfig
} from "../src/config.js";
import { controlServiceStatus, ensureControlService, restartControlService, stopControlService } from "../src/control-service.js";
import { issueReport } from "../src/diagnostics.js";
import { credentialStatus, getCredentials } from "../src/oauth.js";
import { createCodexRouterSession, type PromptStreamResult } from "../src/session.js";
import { closeAll } from "../src/transport.js";

function runBuiltScript(name: string, values: string[] = []): void {
  const file = path.resolve(__dirname, "..", "scripts", name + ".js");
  const result = spawnSync(process.execPath, [file, ...values], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function initialize(): string {
  const file = configPath();
  if (!fs.existsSync(file)) {
    const config: RouterConfig = structuredClone(DEFAULT_CONFIG);
    try {
      credentialStatus("pi");
    } catch {
      credentialStatus("codex");
      config.authStore = "codex";
    }
    writeConfig(config);
  }
  return file;
}

async function ensureAuthenticatedStore(): Promise<void> {
  const config = loadConfig();
  const candidates = [config.authStore, config.authStore === "pi" ? "codex" : "pi"] as const;
  let lastError: unknown;
  for (const store of candidates) {
    try {
      await getCredentials(store);
      if (store !== config.authStore) {
        config.authStore = store;
        writeConfig(config);
      }
      return;
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw new Error("no existing OpenAI OAuth store is valid: " + (lastError instanceof Error ? lastError.message : String(lastError)));
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

function routerModel(value: string | undefined): RouterModel {
  const normalized = String(value || "").toLowerCase();
  const model = ROUTER_MODELS.find((candidate) =>
    candidate === normalized || candidate.endsWith("-" + normalized)
  );
  if (!model) throw new Error("model must be sol, luna, or terra");
  return model;
}

function setContextWindow(modelValue: string | undefined, windowValue: string | undefined): void {
  const config = loadConfig();
  config.contextWindows[routerModel(modelValue)] = parseContextWindow(windowValue);
  console.log("wrote " + writeConfig(config));
}

function setRouterEnabled(enabled: boolean): void {
  const config = loadConfig();
  if (enabled) credentialStatus(config.authStore);
  config.enabled = enabled;
  writeConfig(config);
  runBuiltScript("restart-host");
  console.log("Codex routing switched " + (enabled ? "on" : "off"));
}

function printRoutes(): void {
  const config = loadConfig();
  console.log("default\t" + config.default.model + "\t" + config.default.reasoningEffort);
  for (const [name, route] of Object.entries(config.classes)) {
    console.log("class:" + name + "\t" + route.model + "\t" + route.reasoningEffort);
  }
  const profiles = discoverProfiles();
  const names = new Map(profiles
    .filter((profile) => profile.kind === "agent")
    .map((agent) => [agent.id, agent.name]));
  const roomIds = new Set(profiles.filter((profile) => profile.kind === "room").map((room) => room.id));
  for (const [id, route] of Object.entries(config.agents)) {
    if (roomIds.has(id)) continue;
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
  const agentId = identity ? resolveAgent(identity).id : "router-verification";
  const session = createCodexRouterSession({ sessionOptions: { conversationId: agentId } });
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
  const host = path.join(process.env.SAND_HOST_DIR || path.join(os.homedir(), "sand-host"), "host-main.cjs");
  const patched = fs.existsSync(host) && fs.readFileSync(host, "utf8").includes("GROK_CODEX_ROUTER_SESSION_START");
  const service = controlServiceStatus();
  console.log("config\t" + configPath());
  try {
    const auth = credentialStatus(config.authStore);
    console.log("auth\t" + auth.store + "\tvalid " + Math.floor(auth.validForMs / 60000) + "m");
  } catch {
    console.log("auth\t" + config.authStore + "\tunavailable");
  }
  console.log("host patch\t" + (patched ? "installed" : "missing"));
  console.log("control service\t" + (service.running ? "running" : "stopped") + "\t" + service.url);
  console.log("Codex routing\t" + (config.enabled ? "on" : "off"));
  console.log(
    "context windows\t" +
    ROUTER_MODELS.map((model) =>
      model.slice("gpt-5.6-".length) + "=" + config.contextWindows[model] / 1_000 + "k"
    ).join("\t")
  );
  printRoutes();
}

function printAgents(): void {
  for (const agent of discoverAgents()) console.log(agent.name + "\t" + agent.id);
}

function help(): void {
  console.log([
    "grok-codex-router",
    "",
    "  init",
    "  install",
    "  recover",
    "  status",
    "  agents",
    "  routes",
    "  on",
    "  off",
    "  auth-store pi|codex",
    "  context-window sol|luna|terra 272k|472k|872k",
    "  default MODEL EFFORT",
    "  route AGENT MODEL EFFORT",
    "  class CLASS MODEL EFFORT",
    "  patch-host",
    "  restart-host",
    "  service-start",
    "  service-restart",
    "  service-stop",
    "  service-status",
    "  diagnose",
    "  verify [AGENT]"
  ].join("\n"));
}

async function main(): Promise<void> {
  const [command = "help", ...values] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") help();
  else if (command === "init") console.log("config ready: " + initialize());
  else if (command === "agents") printAgents();
  else if (command === "routes") printRoutes();
  else if (command === "on") setRouterEnabled(true);
  else if (command === "off") setRouterEnabled(false);
  else if (command === "auth-store") setAuthStore(values[0]);
  else if (command === "context-window") setContextWindow(values[0], values[1]);
  else if (command === "status") status();
  else if (command === "default") setRoute("default", values);
  else if (command === "route") setRoute("agent", values);
  else if (command === "class") setRoute("class", values);
  else if (command === "patch-host") runBuiltScript("patch-host", values);
  else if (command === "restart-host") runBuiltScript("restart-host");
  else if (command === "service-start") {
    const service = ensureControlService();
    console.log("control service starting\t" + service.url);
  } else if (command === "service-status") {
    const service = controlServiceStatus();
    console.log((service.running ? "running" : "stopped") + "\t" + service.url + (service.pid ? "\tpid=" + service.pid : ""));
  } else if (command === "service-restart") {
    const service = await restartControlService();
    console.log("control service restarted\t" + service.url);
  } else if (command === "service-stop") {
    await stopControlService();
    console.log("control service stopped");
  } else if (command === "diagnose") {
    console.log(issueReport());
  }
  else if (command === "install" || command === "recover") {
    initialize();
    await ensureAuthenticatedStore();
    runBuiltScript("patch-host");
    await restartControlService();
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
