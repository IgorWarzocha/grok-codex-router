import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ReasoningEffort = "off" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const CONTEXT_WINDOW_OPTIONS = [272_000, 472_000, 872_000] as const;
export type ContextWindowTokens = typeof CONTEXT_WINDOW_OPTIONS[number];
export const ROUTER_MODELS = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"] as const;
export type RouterModel = typeof ROUTER_MODELS[number];
type TransportMode = "cached-websocket" | "websocket" | "sse";
type WorkloadClass = "agent" | "summarization" | "subagent" | "browser" | "computer" | "automation" | "group";
type RoutedWorkload = Exclude<WorkloadClass, "agent">;

interface Route {
  model: string;
  reasoningEffort: ReasoningEffort;
}

export interface ResolvedRoute extends Route {
  workload: WorkloadClass;
  agentId?: string | undefined;
}

export interface RouterConfig {
  version: 1;
  enabled: boolean;
  authStore: "pi" | "codex";
  contextWindows: Record<RouterModel, ContextWindowTokens>;
  default: Route;
  agents: Record<string, Route>;
  classes: Record<RoutedWorkload, Route>;
  transport: {
    mode: TransportMode;
    maxRetries: number;
  };
}

export interface SandSessionOptions {
  conversationId?: unknown;
  isSummarizationSession?: unknown;
  isComputerUseSubagent?: unknown;
  isBrowserUseSubagent?: unknown;
  isSubagent?: unknown;
  isGroupMemberTurn?: unknown;
  requestSource?: unknown;
  [key: string]: unknown;
}

export const DEFAULT_CONFIG = Object.freeze<RouterConfig>({
  version: 1,
  enabled: true,
  authStore: "pi",
  contextWindows: {
    "gpt-5.6-sol": 272_000,
    "gpt-5.6-luna": 272_000,
    "gpt-5.6-terra": 272_000
  },
  default: { model: "gpt-5.6-sol", reasoningEffort: "high" },
  agents: {},
  classes: {
    summarization: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    subagent: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    browser: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    computer: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    automation: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    group: { model: "gpt-5.6-sol", reasoningEffort: "high" }
  },
  transport: {
    mode: "cached-websocket",
    maxRetries: 5
  }
});

const EFFORTS = new Set<ReasoningEffort>(["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CONTEXT_WINDOWS = new Set<number>(CONTEXT_WINDOW_OPTIONS);
const TRANSPORTS = new Set<TransportMode>(["cached-websocket", "websocket", "sse"]);

export function configPath(): string {
  return process.env.SAND_CODEX_ROUTER_CONFIG ||
    path.join(process.env.SAND_DATA_ROOT || path.join(os.homedir(), "sand-data"), "grok-codex-router.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRoute(route: unknown, label: string): Route {
  if (!isRecord(route)) throw new Error(`${label} must be an object`);
  if (typeof route.model !== "string" || !route.model.trim()) {
    throw new Error(`${label}.model must be a non-empty string`);
  }
  const effort = route["reasoningEffort"] ?? "high";
  if (typeof effort !== "string" || !EFFORTS.has(effort as ReasoningEffort)) {
    throw new Error(`${label}.reasoningEffort must be one of ${[...EFFORTS].join(", ")}`);
  }
  return { model: route["model"].trim(), reasoningEffort: effort as ReasoningEffort };
}

export function parseContextWindow(value: unknown): ContextWindowTokens {
  const normalized = typeof value === "string"
    ? value.trim().toLowerCase().replace(/,/g, "")
    : value;
  const tokens = typeof normalized === "string" && normalized.endsWith("k")
    ? Number(normalized.slice(0, -1)) * 1_000
    : Number(normalized);
  if (!CONTEXT_WINDOWS.has(tokens)) {
    throw new Error("contextWindowTokens must be 272000, 472000, or 872000");
  }
  return tokens as ContextWindowTokens;
}

export function contextWindowForModel(config: RouterConfig, model: string): ContextWindowTokens {
  const configuredModel = ROUTER_MODELS.find((candidate) => candidate === model);
  return configuredModel ? config.contextWindows[configuredModel] : 272_000;
}

export function validateConfig(raw: unknown): RouterConfig {
  if (!isRecord(raw)) throw new Error("router config must be an object");
  if (raw.version !== 1) throw new Error("router config version must be 1");
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  if (raw.authStore !== "pi" && raw.authStore !== "codex") {
    throw new Error("authStore must be pi or codex");
  }
  const agents: Record<string, Route> = {};
  if (!isRecord(raw.agents)) throw new Error("agents must be an object");
  for (const [agentId, route] of Object.entries(raw.agents)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) throw new Error(`invalid agent ID: ${agentId}`);
    agents[agentId] = validateRoute(route, `agents.${agentId}`);
  }
  const classes = {} as Record<RoutedWorkload, Route>;
  if (!isRecord(raw.classes)) throw new Error("classes must be an object");
  for (const name of ["summarization", "subagent", "browser", "computer", "automation", "group"]) {
    classes[name as RoutedWorkload] = validateRoute(raw["classes"][name], `classes.${name}`);
  }
  if (!isRecord(raw.transport) || typeof raw.transport["mode"] !== "string" ||
      !TRANSPORTS.has(raw.transport["mode"] as TransportMode)) {
    throw new Error(`transport.mode must be one of ${[...TRANSPORTS].join(", ")}`);
  }
  const maxRetries = Number(raw.transport["maxRetries"]);
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 20) {
    throw new Error("transport.maxRetries must be an integer from 0 to 20");
  }
  const legacyContextWindow = parseContextWindow(
    raw.contextWindowTokens ?? DEFAULT_CONFIG.contextWindows["gpt-5.6-sol"]
  );
  const rawContextWindows = isRecord(raw.contextWindows) ? raw.contextWindows : {};
  const contextWindows = Object.fromEntries(
    ROUTER_MODELS.map((model) => [
      model,
      parseContextWindow(rawContextWindows[model] ?? legacyContextWindow)
    ])
  ) as Record<RouterModel, ContextWindowTokens>;
  return {
    version: 1,
    enabled: raw.enabled ?? true,
    authStore: raw.authStore,
    contextWindows,
    default: validateRoute(raw.default, "default"),
    agents,
    classes,
    transport: { mode: raw.transport["mode"] as TransportMode, maxRetries }
  };
}

export function loadConfig(): RouterConfig {
  const file = configPath();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return structuredClone(DEFAULT_CONFIG);
    }
    throw new Error(`failed to read router config ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateConfig(raw);
}

export function writeConfig(config: RouterConfig): string {
  const valid = validateConfig(config);
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return file;
}

function workloadClass(options: SandSessionOptions = {}): WorkloadClass {
  if (options.isSummarizationSession === true) return "summarization";
  if (options.isComputerUseSubagent === true) return "computer";
  if (options.isBrowserUseSubagent === true) return "browser";
  if (options.isSubagent === true) return "subagent";
  if (options.isGroupMemberTurn === true) return "group";
  if (String(options.requestSource || "").toLowerCase().includes("automation")) return "automation";
  return "agent";
}

export function resolveRoute(config: RouterConfig, sessionOptions: SandSessionOptions = {}): ResolvedRoute {
  const workload = workloadClass(sessionOptions);
  const agentId = typeof sessionOptions.conversationId === "string" ? sessionOptions.conversationId : undefined;
  const route = workload === "agent" && agentId && config.agents[agentId]
    ? config.agents[agentId]
    : workload === "agent"
      ? config.default
      : config.classes[workload as RoutedWorkload];
  return { ...route, workload, agentId };
}
