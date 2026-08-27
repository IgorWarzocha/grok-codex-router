import type { ResponsesBody } from "./wire.js";

export interface ContinuationState {
  request: ResponsesBody;
  responseId?: string | undefined;
  reconstructedItems: unknown[];
}

export interface ContinuationDecision {
  body: ResponsesBody;
  decision: "no-continuation" | "body-mismatch" | "input-shorter-than-baseline" | "input-prefix-mismatch" | "missing-response-id" | "delta";
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    if (key === "internal_chat_message_metadata_passthrough") continue;
    if (key === "id" && record["type"] === "message") continue;
    if (key === "logprobs" && record["type"] === "output_text" && Array.isArray(record[key]) && record[key].length === 0) continue;
    if (key === "status" && record[key] === "completed" &&
        (record["type"] === "function_call" || record["type"] === "custom_tool_call")) continue;
    result[key] = canonicalValue(record[key]);
  }
  return result;
}

function equalValues(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function equalInputs(left: readonly unknown[] = [], right: readonly unknown[] = []): boolean {
  return left.length === right.length && left.every((item, index) => equalValues(item, right[index]));
}

function bodyWithoutContinuation(body: ResponsesBody): Omit<ResponsesBody, "input"> {
  const { input, previous_response_id, client_metadata, ...stable } = body;
  return stable;
}

function callId(item: unknown, type: "call" | "output"): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const supported = type === "call"
    ? record["type"] === "function_call" || record["type"] === "custom_tool_call"
    : record["type"] === "function_call_output" || record["type"] === "custom_tool_call_output";
  return supported && typeof record["call_id"] === "string" ? record["call_id"] : undefined;
}

function pendingToolOutputDelta(state: ContinuationState, body: ResponsesBody): unknown[] | undefined {
  const pending = new Set(state.reconstructedItems.map((item) => callId(item, "call")).filter((id): id is string => Boolean(id)));
  if (pending.size === 0) return undefined;
  let firstOutput: number | undefined;
  for (const [index, item] of body.input.entries()) {
    const id = callId(item, "output");
    if (!id || !pending.has(id)) continue;
    firstOutput ??= index;
    pending.delete(id);
  }
  return pending.size === 0 && firstOutput !== undefined ? body.input.slice(firstOutput) : undefined;
}

export function continuationRequest(state: ContinuationState | undefined, body: ResponsesBody): ContinuationDecision {
  if (!state) return { body, decision: "no-continuation" };
  if (!equalValues(bodyWithoutContinuation(state.request), bodyWithoutContinuation(body))) {
    return { body, decision: "body-mismatch" };
  }
  const baseline = [...state.request.input, ...state.reconstructedItems];
  if (body.input.length < baseline.length) {
    return { body, decision: "input-shorter-than-baseline" };
  }
  if (!equalInputs(body.input.slice(0, baseline.length), baseline)) {
    const delta = pendingToolOutputDelta(state, body);
    if (delta) {
      if (!state.responseId) return { body, decision: "missing-response-id" };
      return { body: { ...body, previous_response_id: state.responseId, input: delta }, decision: "delta" };
    }
    return { body, decision: "input-prefix-mismatch" };
  }
  if (!state.responseId) return { body, decision: "missing-response-id" };
  return {
    body: {
      ...body,
      previous_response_id: state.responseId,
      input: body.input.slice(baseline.length)
    },
    decision: "delta"
  };
}
