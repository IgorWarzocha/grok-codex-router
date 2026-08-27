import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "./codex-policy.js";
import { continuationRequest } from "./continuation.js";
import { recordEvent } from "./event-log.js";
import type { Credentials } from "./oauth.js";
import { collectResponse, type TransportResult } from "./response.js";
import {
  captureCodexTurnState,
  withCodexTurnState,
  type CodexTurnState
} from "./turn-state.js";
import {
  acquireWebSocketLane,
  releaseWebSocketLane
} from "./websocket-lanes.js";
import { websocketEvents } from "./websocket-stream.js";
import type { ResponsesBody } from "./wire.js";

export async function websocketAttempt(options: {
  body: ResponsesBody;
  credentials: Credentials;
  sessionId: string;
  invocationId: string | undefined;
  useCachedContext: boolean;
  turnState: CodexTurnState;
  signal?: AbortSignal | undefined;
}): Promise<TransportResult> {
  const { body, credentials, sessionId, invocationId, useCachedContext, turnState, signal } = options;
  const acquired = await acquireWebSocketLane(sessionId, credentials, body.model, signal);
  const continuation = useCachedContext
    ? continuationRequest(acquired.lane.continuation, body)
    : { body, decision: "disabled" as const };
  let keep = false;
  recordEvent({
    type: "request",
    transport: "websocket",
    model: body.model,
    sessionId,
    socketReused: acquired.reused,
    continuation: continuation.decision,
    fullInputItems: body.input.length,
    sentInputItems: continuation.body.input.length
  });
  try {
    acquired.lane.socket.send(JSON.stringify({
      type: "response.create",
      ...withCodexTurnState(continuation.body, turnState)
    }));
    const result = await collectResponse(
      websocketEvents(
        acquired.lane.socket,
        signal,
        DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        (event) => captureCodexTurnState(event, turnState)
      ),
      body.model,
      invocationId
    );
    acquired.lane.continuation = useCachedContext
      ? {
          request: body,
          responseId: result.responseId,
          reconstructedItems: result.reconstructedItems
        }
      : undefined;
    keep = true;
    return {
      ...result,
      transport: "websocket",
      continuation: continuation.decision,
      socketReused: acquired.reused
    };
  } catch (error: unknown) {
    acquired.lane.continuation = undefined;
    throw error;
  } finally {
    releaseWebSocketLane(acquired, keep);
  }
}
