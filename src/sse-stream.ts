import type { StreamEvent } from "./response.js";

export async function* parseSSE(
  response: Response,
  signal: AbortSignal | undefined,
  idleTimeoutMs?: number
): AsyncIterable<StreamEvent> {
  if (!response.body) throw new Error("Codex SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Request was aborted");
      let timer: NodeJS.Timeout | undefined;
      const read = reader.read();
      const item = idleTimeoutMs === undefined || idleTimeoutMs <= 0
        ? await read
        : await Promise.race<ReadableStreamReadResult<Uint8Array>>([
            read,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(
                new Error("Codex SSE stream idle timeout after " + idleTimeoutMs + "ms")
              ), idleTimeoutMs);
            })
          ]).finally(() => {
            if (timer) clearTimeout(timer);
          });
      if (signal?.aborted) throw new Error("Request was aborted");
      if (item.done) break;
      buffer += decoder.decode(item.value, { stream: true });
      const trailingCarriageReturn = buffer.endsWith("\r");
      const complete = trailingCarriageReturn ? buffer.slice(0, -1) : buffer;
      buffer = complete.replace(/\r\n/g, "\n").replace(/\r/g, "\n") + (trailingCarriageReturn ? "\r" : "");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = chunk.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data) as StreamEvent;
        } catch {}
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    try {
      await reader.cancel();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
}
