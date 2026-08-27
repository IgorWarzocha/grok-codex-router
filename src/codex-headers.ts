import type { Credentials } from "./oauth.js";

export function baseCodexHeaders(credentials: Credentials, sessionId: string): Record<string, string> {
  return {
    Authorization: "Bearer " + credentials.access,
    "chatgpt-account-id": credentials.accountId,
    originator: "grok-codex-router",
    "User-Agent": "grok-codex-router (" + process.platform + "; " + process.arch + ")",
    "x-client-request-id": sessionId,
    "session-id": sessionId,
    "thread-id": sessionId
  };
}
