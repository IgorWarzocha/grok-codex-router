import type { StreamEvent } from "./response.js";
import type { ResponsesBody } from "./wire.js";

export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";

export interface CodexTurnState {
  current(): string | undefined;
  capture(value: string | null | undefined): void;
}

export function createCodexTurnState(): CodexTurnState {
  let value: string | undefined;
  return {
    current: () => value,
    capture(next) {
      if (value !== undefined || !next?.trim()) return;
      value = next.trim();
    }
  };
}

export function withCodexTurnState(body: ResponsesBody, state: CodexTurnState): ResponsesBody {
  const current = state.current();
  return current
    ? {
        ...body,
        client_metadata: { ...(body.client_metadata ?? {}), [CODEX_TURN_STATE_HEADER]: current }
      }
    : body;
}

export function captureCodexTurnState(event: StreamEvent, state: CodexTurnState): void {
  if (event.type !== "response.metadata" && event.type !== "codex.response.metadata") return;
  const headers = event["headers"];
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === CODEX_TURN_STATE_HEADER && typeof value === "string") state.capture(value);
  }
}
