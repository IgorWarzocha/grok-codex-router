import crypto from "node:crypto";
import WebSocket from "ws";
import {
  DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
  OPENAI_BETA_RESPONSES_WEBSOCKETS
} from "./codex-policy.js";
import { baseCodexHeaders } from "./codex-headers.js";
import type { Credentials } from "./oauth.js";
import type { ContinuationState } from "./continuation.js";
import type { RouterError } from "./recovery.js";

const CODEX_WS_URL = "wss://chatgpt.com/backend-api/codex/responses";

interface WebSocketLane {
  socket: WebSocket;
  busy: boolean;
  continuation?: ContinuationState | undefined;
}

export interface AcquiredWebSocketLane {
  key: string;
  lane: WebSocketLane;
  reused: boolean;
  retained: boolean;
}

const lanes = new Map<string, WebSocketLane>();
const stickySSE = new Set<string>();

function headers(credentials: Credentials, sessionId: string): Record<string, string> {
  return {
    ...baseCodexHeaders(credentials, sessionId),
    "OpenAI-Beta": OPENAI_BETA_RESPONSES_WEBSOCKETS
  };
}

function isOpen(socket: WebSocket | undefined): boolean {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function closeLane(key: string, lane: WebSocketLane): void {
  try { lane.socket.close(1000, "router_reset"); } catch {}
  if (lanes.get(key) === lane) lanes.delete(key);
}

function connect(credentials: Credentials, sessionId: string, signal?: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(CODEX_WS_URL, {
      headers: headers(credentials, sessionId),
      handshakeTimeout: DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
      perMessageDeflate: false
    });
    let settled = false;
    const cleanup = () => {
      socket.off("open", open);
      socket.off("error", error);
      socket.off("unexpected-response", unexpected);
      signal?.removeEventListener("abort", abort);
    };
    const open = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const error = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    };
    const unexpected = (_request: unknown, response: { statusCode: number }) => {
      const cause = new Error("WebSocket handshake failed with HTTP " + response.statusCode) as RouterError;
      cause.status = response.statusCode;
      error(cause);
    };
    const abort = () => {
      try { socket.close(1000, "aborted"); } catch {}
      const cause = new Error("Request was aborted") as RouterError;
      cause.code = "ABORTED";
      error(cause);
    };
    socket.once("open", open);
    socket.once("error", error);
    socket.once("unexpected-response", unexpected);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function acquireWebSocketLane(
  sessionId: string,
  credentials: Credentials,
  model: string,
  signal?: AbortSignal
): Promise<AcquiredWebSocketLane> {
  const credentialIdentity = crypto.createHash("sha256").update(credentials.access).digest("base64url");
  const key = sessionId + "\u0000" + credentials.accountId + "\u0000" + credentialIdentity + "\u0000" + model;
  let cached = lanes.get(key);
  if (cached && !cached.busy && isOpen(cached.socket)) {
    cached.busy = true;
    return { key, lane: cached, reused: true, retained: true };
  }
  if (cached && !isOpen(cached.socket)) {
    closeLane(key, cached);
    cached = undefined;
  }
  const socket = await connect(credentials, sessionId, signal);
  const lane: WebSocketLane = { socket, busy: true };
  if (!cached) lanes.set(key, lane);
  return { key, lane, reused: false, retained: !cached };
}

export function releaseWebSocketLane(acquired: AcquiredWebSocketLane, keep: boolean): void {
  if (!acquired.retained) {
    try { acquired.lane.socket.close(1000, "transient_done"); } catch {}
    return;
  }
  if (!keep || !isOpen(acquired.lane.socket)) {
    closeLane(acquired.key, acquired.lane);
    return;
  }
  acquired.lane.busy = false;
}

export function isWebSocketSseFallbackActive(sessionId: string): boolean {
  return stickySSE.has(sessionId);
}

export function recordWebSocketSseFallback(sessionId: string): void {
  stickySSE.add(sessionId);
}

export function closeAllWebSocketSessions(): void {
  for (const [key, lane] of lanes) closeLane(key, lane);
  stickySSE.clear();
}
