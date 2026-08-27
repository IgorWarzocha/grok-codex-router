import type WebSocket from "ws";
import type { RawData } from "ws";
import { DEFAULT_WEBSOCKET_CLOSE_TIMEOUT_MS } from "./codex-policy.js";
import type { StreamEvent } from "./response.js";

export function websocketEvents(
  socket: WebSocket,
  signal: AbortSignal | undefined,
  idleTimeoutMs?: number,
  onEvent?: ((event: StreamEvent) => void) | undefined
): AsyncIterable<StreamEvent> {
  const queue: StreamEvent[] = [];
  let pending: (() => void) | undefined;
  let ended = false;
  let failure: Error | undefined;
  let socketError: Error | undefined;
  let socketErrorTimer: NodeJS.Timeout | undefined;
  const wake = () => {
    const resolve = pending;
    pending = undefined;
    resolve?.();
  };
  const onMessage = (data: RawData) => {
    try {
      const event = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)) as StreamEvent;
      onEvent?.(event);
      queue.push(event);
      if (event.type && ["response.completed", "response.done", "response.incomplete"].includes(event.type)) {
        ended = true;
      }
    } catch {}
    wake();
  };
  const onError = (error: Error) => {
    socketError = error instanceof Error ? error : new Error(String(error));
    if (socketErrorTimer) clearTimeout(socketErrorTimer);
    socketErrorTimer = setTimeout(() => {
      failure = socketError;
      ended = true;
      wake();
    }, DEFAULT_WEBSOCKET_CLOSE_TIMEOUT_MS);
  };
  const onClose = (code: number, reason: Buffer) => {
    if (socketErrorTimer) clearTimeout(socketErrorTimer);
    if (!ended && !failure) {
      const close = new Error("WebSocket closed " + code + (reason.length ? " " + reason.toString() : ""));
      (close as Error & { closeCode?: number }).closeCode = code;
      failure = code === 1009 || !socketError ? close : socketError;
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
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) onAbort();
  return {
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          if (signal?.aborted) throw new Error("Request was aborted");
          if (queue.length) {
            yield queue.shift()!;
            continue;
          }
          if (failure) throw failure;
          if (ended) return;
          let idleTimer: NodeJS.Timeout | undefined;
          await new Promise<void>((resolve) => {
            pending = resolve;
            if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
              idleTimer = setTimeout(() => {
                failure = new Error("Codex WebSocket idle timeout after " + idleTimeoutMs + "ms");
                (failure as Error & { code?: string }).code = "WS_IDLE_TIMEOUT";
                ended = true;
                wake();
              }, idleTimeoutMs);
            }
          }).finally(() => {
            if (idleTimer) clearTimeout(idleTimer);
          });
        }
      } finally {
        if (socketErrorTimer) clearTimeout(socketErrorTimer);
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.off("close", onClose);
        signal?.removeEventListener("abort", onAbort);
      }
    }
  };
}
