import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type WebSocket from "ws";
import { parseSSE } from "../src/sse-stream.js";
import { websocketEvents } from "../src/websocket-stream.js";
import type { RouterError } from "../src/recovery.js";

test("SSE decoding preserves events across split CRLF boundaries", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"first"}\r'));
      controller.enqueue(encoder.encode('\n\r'));
      controller.enqueue(encoder.encode('\ndata: {"type":"second"}\n\n'));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  const events = [];
  for await (const event of parseSSE(new Response(body), undefined)) events.push(event.type);
  assert.deepEqual(events, ["first", "second"]);
});

test("WebSocket decoding preserves an oversized-frame close after a generic error", async () => {
  const socket = new EventEmitter() as WebSocket;
  const iterator = websocketEvents(socket, undefined, 0)[Symbol.asyncIterator]();
  const next = iterator.next();
  socket.emit("error", new Error("transport failed"));
  socket.emit("close", 1009, Buffer.alloc(0));

  await assert.rejects(next, (error: RouterError) => error.closeCode === 1009);
});

test("WebSocket listeners are released when a response completes", async () => {
  const socket = new EventEmitter() as WebSocket;
  const iterator = websocketEvents(socket, undefined, 0)[Symbol.asyncIterator]();
  const next = iterator.next();
  socket.emit("message", Buffer.from('{"type":"response.completed","response":{"status":"completed"}}'));
  assert.equal((await next).value?.type, "response.completed");
  assert.equal((await iterator.next()).done, true);
  assert.equal(socket.listenerCount("message"), 0);
  assert.equal(socket.listenerCount("error"), 0);
  assert.equal(socket.listenerCount("close"), 0);
});
