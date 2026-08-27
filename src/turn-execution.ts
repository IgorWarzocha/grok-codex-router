import {
  loadConfig,
  resolveRoute,
  type SandSessionOptions
} from "./config.js";
import { recordEvent } from "./event-log.js";
import { getCredentials } from "./oauth.js";
import type { RouterResult } from "./response.js";
import type { CodexTurnState } from "./turn-state.js";
import { runTransport } from "./transport.js";
import { buildRequest } from "./wire.js";

export async function executeCodexTurn(options: {
  messages: unknown[];
  tools: unknown;
  sessionOptions: SandSessionOptions;
  sessionId: string;
  invocationId: string | undefined;
  turnState: CodexTurnState;
  signal?: AbortSignal | undefined;
}): Promise<RouterResult> {
  const {
    messages,
    tools,
    sessionOptions,
    sessionId,
    invocationId,
    turnState,
    signal
  } = options;
  const config = loadConfig();
  const route = resolveRoute(config, sessionOptions);
  const body = buildRequest(messages, tools, route, sessionId);
  const credentials = await getCredentials(config.authStore, signal);
  recordEvent({
    type: "route",
    sessionId,
    agentId: route.agentId,
    workload: route.workload,
    model: route.model,
    reasoningEffort: route.reasoningEffort
  });
  const startedAt = Date.now();
  const result = await runTransport({
    body,
    credentials,
    sessionId,
    invocationId,
    config,
    turnState,
    signal
  });
  recordEvent({
    type: "turn",
    sessionId,
    agentId: route.agentId,
    workload: route.workload,
    model: route.model,
    reasoningEffort: route.reasoningEffort,
    transport: result.transport,
    continuation: result.continuation,
    socketReused: result.socketReused,
    inputTokens: result.extendedUsage.inputTokens,
    cachedInputTokens: result.extendedUsage.cacheReadTokens,
    cacheWriteInputTokens: result.extendedUsage.cacheWriteTokens,
    outputTokens: result.extendedUsage.outputTokens,
    durationMs: Date.now() - startedAt
  });
  return result;
}
