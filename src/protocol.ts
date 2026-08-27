import type WebSocket from "ws";
import type { RawData } from "ws";
import type { StreamEvent } from "./response.js";
import type { ResponsesBody } from "./wire.js";

export interface ContinuationState {
  request: ResponsesBody;
  responseId?: string | undefined;
  reconstructedItems: unknown[];
}

export interface ContinuationDecision {
  body: ResponsesBody;
  decision: "no-continuation" | "body-mismatch" | "input-prefix-mismatch" | "missing-response-id" | "delta";
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
    if (key === "status" && record[key] === "completed" && record["type"] === "function_call") continue;
    result[key] = canonicalValue(record[key]);
  }
  return result;
}

export function equalValues(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

export function equalInputs(left: readonly unknown[] = [], right: readonly unknown[] = []): boolean {
  return left.length === right.length && left.every((item, index) => equalValues(item, right[index]));
}

function bodyWithoutContinuation(body: ResponsesBody): Omit<ResponsesBody, "input"> {
  const { input, previous_response_id, client_metadata, ...stable } = body;
  return stable;
}

export function continuationRequest(state: ContinuationState | undefined, body: ResponsesBody): ContinuationDecision {
  if (!state) return { body, decision: "no-continuation" };
  if (!equalValues(bodyWithoutContinuation(state.request), bodyWithoutContinuation(body))) {
    return { body, decision: "body-mismatch" };
  }
  const baseline = [...state.request.input, ...state.reconstructedItems];
  if (body.input.length < baseline.length || !equalInputs(body.input.slice(0, baseline.length), baseline)) {
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

export async function* parseSSE(
  response: Response,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number
): AsyncIterable<StreamEvent> {
  if (!response.body) throw new Error("Codex SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal && signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal && signal.aborted) throw new Error("Request was aborted");
      let timer: NodeJS.Timeout | undefined;
      const read = reader.read();
      const item = await Promise.race<ReadableStreamReadResult<Uint8Array>>([
        read,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Codex SSE idle timeout after " + idleTimeoutMs + "ms")), idleTimeoutMs);
        })
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (item.done) break;
      buffer += decoder.decode(item.value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = chunk.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        try { yield JSON.parse(data) as StreamEvent; } catch {}
      }
    }
  } finally {
    signal && signal.removeEventListener("abort", abort);
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}

export function websocketEvents(
  socket: WebSocket,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number
): AsyncIterable<StreamEvent> {
  const queue: StreamEvent[] = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  let failure: Error | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const wake = () => {
    while (waiters.length && (queue.length || ended || failure)) waiters.shift()?.();
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      failure = new Error("Codex WebSocket idle timeout after " + idleTimeoutMs + "ms");
      (failure as Error & { code?: string }).code = "WS_IDLE_TIMEOUT";
      wake();
    }, idleTimeoutMs);
  };
  const onMessage = (data: RawData) => {
    armIdle();
    try {
      const event = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)) as StreamEvent;
      queue.push(event);
      if (event.type && ["response.completed", "response.done", "response.incomplete"].includes(event.type)) ended = true;
    } catch {}
    wake();
  };
  const onError = (error: Error) => {
    failure = error instanceof Error ? error : new Error(String(error));
    wake();
  };
  const onClose = (code: number, reason: Buffer) => {
    if (!ended && !failure) {
      failure = new Error("WebSocket closed " + code + (reason && reason.length ? " " + reason.toString() : ""));
      (failure as Error & { closeCode?: number }).closeCode = code;
    }
    ended = true;
    wake();
  };
  const onAbort = () => {
    failure = new Error("Request was aborted");
    (failure as Error & { code?: string }).code = "ABORTED";
    wake();
  };
  socket.on("message", onMessage);
  socket.on("error", onError);
  socket.on("close", onClose);
  signal && signal.addEventListener("abort", onAbort);
  armIdle();
  return {
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          if (queue.length) {
            yield queue.shift()!;
            continue;
          }
          if (failure) throw failure;
          if (ended) return;
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      } finally {
        clearTimeout(idleTimer);
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.off("close", onClose);
        signal && signal.removeEventListener("abort", onAbort);
      }
    }
  };
}
