import type { ResolvedRoute } from "./config.js";
import { convertMessages } from "./message-wire.js";
import { convertTools } from "./tool-wire.js";
import type { JsonObject } from "./sand-values.js";

export interface ResponsesBody extends JsonObject {
  model: string;
  store: false;
  stream: true;
  instructions: string;
  input: unknown[];
  previous_response_id?: string | undefined;
  client_metadata: Record<string, string>;
}

function promptCacheKey(sessionId: string): string {
  return Array.from(String(sessionId)).slice(0, 64).join("");
}

export function buildRequest(messages: unknown, tools: unknown, route: ResolvedRoute, sessionId: string): ResponsesBody {
  const converted = convertMessages(messages);
  const body: ResponsesBody = {
    model: route.model,
    store: false,
    stream: true,
    instructions: converted.instructions,
    input: converted.input,
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: promptCacheKey(sessionId),
    tool_choice: "auto",
    parallel_tool_calls: true,
    client_metadata: { session_id: sessionId, thread_id: sessionId }
  };
  const convertedTools = convertTools(tools);
  if (convertedTools) body.tools = convertedTools;
  if (route.reasoningEffort !== "off") {
    const effort = /^gpt-5\.(?:[2-9]|\d{2,})/.test(route.model) && route.reasoningEffort === "minimal"
      ? "low"
      : route.reasoningEffort;
    body.reasoning = { effort, summary: "auto" };
  }
  return body;
}
