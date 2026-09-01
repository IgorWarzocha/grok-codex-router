import crypto from "node:crypto";
import { loadConfig, resolveRoute, type ResolvedRoute, type SandSessionOptions } from "./config.js";
export { ensureControlService } from "./control-service.js";
import { type NormalizedUsage, type RouterResult, type StreamPart } from "./response.js";
import { createCodexTurnState } from "./turn-state.js";
import { executeCodexTurn } from "./turn-execution.js";

interface SessionOptions {
  requestedModel?: unknown;
  onRequestId?: ((requestId: string | undefined) => void) | undefined;
  sessionOptions?: SandSessionOptions | undefined;
}

interface SandContext {
  signal?: AbortSignal | undefined;
}

export interface PromptStreamResult {
  fullStream: AsyncIterable<StreamPart>;
  response: Promise<Record<string, unknown>>;
  usage: Promise<NormalizedUsage["usage"]>;
  extendedUsage: Promise<NormalizedUsage["extendedUsage"]>;
  providerMetadata: Promise<Record<string, unknown>>;
  invocationId: Promise<string | undefined>;
}

export interface PromptExecutor {
  appendMessages(messages: unknown): PromptExecutor;
  getMessages(): unknown[];
  getState(): unknown[];
  clearMessages(): void;
  stream(ctx: SandContext | undefined, invocationId: string | undefined, tools: unknown): PromptStreamResult;
}

export interface CodexRouterSession {
  requestedModel: unknown;
  onRequestId?: ((requestId: string | undefined) => void) | undefined;
  sessionOptions: SandSessionOptions;
  route: ResolvedRoute;
  sessionId: string;
  nextExecutorOrdinal: number;
  getModelId(): string;
  getExecutor(initialMessages?: unknown): PromptExecutor;
}

function sessionIdFor(route: ResolvedRoute): string {
  const identity = route.agentId || crypto.randomUUID();
  return ("grok:" + identity + ":" + route.workload).slice(0, 64);
}

export function executorSessionIdFor(sessionId: string, ordinal: number): string {
  if (ordinal === 0) return sessionId;
  const suffix = ":aux:" + ordinal;
  return sessionId.slice(0, 64 - suffix.length) + suffix;
}

function emptyUsage(): NormalizedUsage {
  return {
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    extendedUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 }
  };
}

export function errorResult(model: string, invocationId: string | undefined, error: unknown): RouterResult {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const response = {
    modelId: model,
    messages: [{ role: "assistant", content: "" }],
    finishReason: "error"
  };
  const usage = emptyUsage();
  return {
    parts: [
      { type: "error", error: normalized },
      { type: "finish", finishReason: "error", usage: usage.usage, response }
    ],
    response,
    ...usage,
    providerMetadata: {},
    invocationId,
    responseId: undefined,
    outputItems: [],
    reconstructedItems: []
  };
}

function resultSurface(processing: Promise<RouterResult>, invocationId: string | undefined): PromptStreamResult {
  const fullStream = (async function* () {
    const result = await processing;
    for (const part of result.parts) yield part;
  })();
  return {
    fullStream,
    response: processing.then((result) => result.response),
    usage: processing.then((result) => result.usage),
    extendedUsage: processing.then((result) => result.extendedUsage),
    providerMetadata: processing.then((result) => result.providerMetadata),
    invocationId: processing.then((result) => result.invocationId || invocationId)
  };
}

export function createExecutor(
  session: CodexRouterSession,
  executorSessionId: string,
  initialMessages?: unknown
): PromptExecutor {
  const state = { messages: [] as unknown[], turnState: createCodexTurnState() };
  if (initialMessages) {
    state.messages.push(...(Array.isArray(initialMessages) ? initialMessages : [initialMessages]));
  }
  return {
    appendMessages(messages: unknown) {
      state.messages.push(...(Array.isArray(messages) ? messages : messages == null ? [] : [messages]));
      return this;
    },
    getMessages() {
      return [...state.messages];
    },
    getState() {
      return [...state.messages];
    },
    clearMessages() {
      state.messages = [];
    },
    stream(ctx: SandContext | undefined, invocationId: string | undefined, tools: unknown) {
      try { session.onRequestId && session.onRequestId(invocationId); } catch {}
      const processing = (async () => {
        try {
          return await executeCodexTurn({
            messages: state.messages,
            tools,
            sessionOptions: session.sessionOptions,
            sessionId: executorSessionId,
            invocationId,
            turnState: state.turnState,
            signal: ctx?.signal
          });
        } catch (error) {
          return errorResult(session.route.model, invocationId, error);
        }
      })();
      return resultSurface(processing, invocationId);
    }
  };
}

export function isCodexRouterEnabled(): boolean {
  return loadConfig().enabled;
}

export function createCodexRouterSession(options: SessionOptions = {}): CodexRouterSession {
  const config = loadConfig();
  const sessionOptions = options.sessionOptions || {};
  const route = resolveRoute(config, sessionOptions);
  const session: CodexRouterSession = {
    requestedModel: options.requestedModel,
    onRequestId: options.onRequestId,
    sessionOptions,
    route,
    sessionId: sessionIdFor(route),
    nextExecutorOrdinal: 0,
    getModelId() {
      return this.route.model;
    },
    getExecutor(initialMessages) {
      const ordinal = session.nextExecutorOrdinal++;
      const executorSessionId = executorSessionIdFor(session.sessionId, ordinal);
      return createExecutor(session, executorSessionId, initialMessages);
    }
  };
  console.error(
    "[grok-codex-router] session agent=" + (route.agentId || "unidentified") +
    " workload=" + route.workload +
    " model=" + route.model +
    " effort=" + route.reasoningEffort
  );
  return session;
}
