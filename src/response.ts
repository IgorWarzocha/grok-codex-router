import {
  isRecord,
  parseArguments,
  sanitizeToolId,
  sanitizeToolName,
  stringValue,
  type JsonObject
} from "./sand-values.js";
import { assistantMessageItem } from "./message-wire.js";
import type { ContextWindowTokens } from "./config.js";

export interface StreamEvent extends JsonObject {
  type?: string;
  delta?: unknown;
  arguments?: unknown;
  output_index?: unknown;
  item?: JsonObject;
  response?: ProviderResponse;
  error?: JsonObject;
  message?: unknown;
  code?: unknown;
  status?: unknown;
}

interface ProviderResponse extends JsonObject {
  id?: unknown;
  status?: unknown;
  usage?: JsonObject;
  incomplete_details?: JsonObject;
  error?: JsonObject;
}

export interface NormalizedUsage {
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  extendedUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    maxTokens: number;
  };
}

interface AccumulatedCall {
  id: string;
  name: string;
  arguments: string;
  started: boolean;
}

export type StreamPart = JsonObject & { type: string };

export interface RouterResult extends NormalizedUsage {
  parts: StreamPart[];
  response: JsonObject;
  providerMetadata: JsonObject;
  invocationId: string | undefined;
  responseId: string | undefined;
  outputItems: unknown[];
  reconstructedItems: unknown[];
}

export type TransportResult = RouterResult & {
  transport: "websocket" | "sse";
  continuation: string;
  socketReused: boolean;
};

export function reportContextWindow(
  result: TransportResult,
  maxTokens: ContextWindowTokens
): TransportResult {
  return {
    ...result,
    extendedUsage: {
      ...result.extendedUsage,
      maxTokens
    }
  };
}

function usageFromResponse(response: ProviderResponse | undefined): NormalizedUsage {
  const usage = isRecord(response?.usage) ? response.usage : {};
  const details = isRecord(usage["input_tokens_details"]) ? usage["input_tokens_details"] : {};
  const cached = Number(details["cached_tokens"]) || 0;
  const cacheWrite = Number(details["cache_write_tokens"]) || 0;
  const input = Math.max(0, (Number(usage["input_tokens"]) || 0) - cached - cacheWrite);
  const output = Number(usage["output_tokens"]) || 0;
  return {
    usage: { promptTokens: input + cached + cacheWrite, completionTokens: output, totalTokens: input + cached + cacheWrite + output },
    extendedUsage: { inputTokens: input, outputTokens: output, cacheReadTokens: cached, cacheWriteTokens: cacheWrite, maxTokens: 0 }
  };
}

export class ResponseAccumulator {
  text = "";
  reasoning = "";
  calls = new Map<string, AccumulatedCall>();
  outputItems: unknown[] = [];
  response: ProviderResponse | undefined;
  responseId: string | undefined;

  private callFor(event: StreamEvent): AccumulatedCall {
    const item = event.item || {};
    const key = String(event.output_index ?? item["id"] ?? item["call_id"] ?? this.calls.size);
    let call = this.calls.get(key);
    if (!call) {
      call = { id: "", name: "", arguments: "", started: false };
      this.calls.set(key, call);
    }
    if (item["call_id"]) call.id = sanitizeToolId(item["call_id"]);
    if (item["name"]) call.name = sanitizeToolName(item["name"]);
    if (typeof item["arguments"] === "string") call.arguments = item["arguments"];
    return call;
  }

  consume(event: StreamEvent, push: (part: StreamPart) => void): void {
    if (typeof event.type !== "string") return;
    if (event.type === "error" || event.type === "response.failed") {
      const nested = event.error || event.response?.error || {};
      const error = new Error(stringValue(nested["message"] || event.message || nested["code"] || "Codex response failed"));
      (error as Error & { code?: unknown }).code = nested["code"] || event.code;
      (error as Error & { status?: unknown }).status = nested["status"] || event.status;
      throw error;
    }
    if (event.type === "response.created" && typeof event.response?.id === "string") {
      this.responseId = event.response.id;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      this.text += event.delta;
      push({ type: "text-delta", textDelta: event.delta });
    }
    if (event.type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
      this.reasoning += event.delta;
      push({ type: "reasoning", textDelta: event.delta });
    }
    if (event.type === "response.output_item.added" && event.item?.["type"] === "function_call") {
      const call = this.callFor(event);
      if (call.id && call.name && !call.started) {
        call.started = true;
        push({ type: "tool-call-streaming-start", toolCallId: call.id, toolName: call.name });
      }
    }
    if (event.type === "response.function_call_arguments.delta") {
      const call = this.callFor(event);
      if (typeof event.delta === "string") {
        call.arguments += event.delta;
        if (call.id && call.name) {
          if (!call.started) {
            call.started = true;
            push({ type: "tool-call-streaming-start", toolCallId: call.id, toolName: call.name });
          }
          push({ type: "tool-call-delta", toolCallId: call.id, toolName: call.name, argsTextDelta: event.delta });
        }
      }
    }
    if (event.type === "response.function_call_arguments.done") {
      const call = this.callFor(event);
      if (typeof event.arguments === "string") call.arguments = event.arguments;
    }
    if (event.type === "response.output_item.done" && event.item) {
      this.outputItems.push(event.item);
      if (event.item["type"] === "function_call") this.callFor(event);
    }
    if (["response.completed", "response.done", "response.incomplete"].includes(event.type)) {
      this.response = event.response || {};
      if (typeof this.response.id === "string") this.responseId = this.response.id;
    }
  }

  result(model: string, invocationId: string | undefined, parts: StreamPart[]): RouterResult {
    const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
    for (const call of this.calls.values()) {
      const id = sanitizeToolId(call.id || "call_" + toolCalls.length);
      const name = sanitizeToolName(call.name);
      const args = parseArguments(call.arguments);
      toolCalls.push({ id, name, args });
      parts.push({ type: "tool-call", toolCallId: id, toolName: name, args });
    }
    const incomplete = this.response?.status === "incomplete";
    const incompleteDetails = isRecord(this.response?.incomplete_details) ? this.response.incomplete_details : {};
    const reason = incomplete && incompleteDetails["reason"] === "max_output_tokens"
      ? "length"
      : toolCalls.length ? "tool-calls" : "stop";
    const messages = toolCalls.length
      ? [{ role: "assistant", content: [
          ...(this.text ? [{ type: "text", text: this.text }] : []),
          ...toolCalls.map((call) => ({ type: "tool-call", toolCallId: call.id, toolName: call.name, args: call.args }))
        ] }]
      : [{ role: "assistant", content: this.text }];
    const response = { modelId: model, messages, finishReason: reason };
    const normalized = usageFromResponse(this.response);
    parts.push({ type: "finish", finishReason: reason, usage: normalized.usage, response });
    return {
      parts,
      response,
      ...normalized,
      providerMetadata: this.reasoning ? { reasoning: this.reasoning } : {},
      invocationId,
      responseId: this.responseId,
      outputItems: this.outputItems,
      reconstructedItems: [
        ...(this.text ? [assistantMessageItem(this.text)] : []),
        ...toolCalls.map((call) => ({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args)
        }))
      ]
    };
  }
}

export async function collectResponse(
  events: AsyncIterable<StreamEvent>,
  model: string,
  invocationId: string | undefined
): Promise<RouterResult> {
  const accumulator = new ResponseAccumulator();
  const parts: StreamPart[] = [];
  for await (const event of events) accumulator.consume(event, (part) => parts.push(part));
  if (!accumulator.response) throw new Error("Codex stream closed before response.completed");
  if (accumulator.response.status === "failed" || accumulator.response.status === "cancelled") {
    const error = new Error("Codex response ended without a successful result") as Error & { retryable?: boolean };
    error.retryable = false;
    throw error;
  }
  return accumulator.result(model, invocationId, parts);
}
