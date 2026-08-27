import crypto from "node:crypto";
import type { ResolvedRoute } from "./config.js";

export type JsonObject = Record<string, unknown>;

interface SandPart extends JsonObject {
  type?: unknown;
  kind?: unknown;
  text?: unknown;
  content?: unknown;
  textDelta?: unknown;
  thinking?: unknown;
  image_url?: unknown;
  url?: unknown;
  image?: unknown;
  detail?: unknown;
  function?: unknown;
  toolCallId?: unknown;
  tool_call_id?: unknown;
  call_id?: unknown;
  id?: unknown;
  toolName?: unknown;
  tool_name?: unknown;
  name?: unknown;
  args?: unknown;
  arguments?: unknown;
  input?: unknown;
  result?: unknown;
  output?: unknown;
  value?: unknown;
  isError?: unknown;
  is_error?: unknown;
}

interface SandMessage extends SandPart {
  role?: unknown;
  toolCalls?: unknown;
  tool_calls?: unknown;
}

interface SandTool extends JsonObject {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  inputSchema?: unknown;
  schema?: unknown;
}

export interface ResponsesBody extends JsonObject {
  model: string;
  store: false;
  stream: true;
  instructions: string;
  input: unknown[];
  previous_response_id?: string | undefined;
  client_metadata: Record<string, string>;
}

const SEND_VARIANTS: Record<string, readonly string[]> = {
  text: ["type", "content", "images", "reply_to", "channel", "to"],
  attachment: ["type", "url", "alt", "reply_to", "channel"],
  widget: ["type", "widget", "reply_to"],
  "cursor-agent": ["type", "bcId", "reply_to"],
  "secret-request": ["type", "secret", "reply_to"]
};

const SEND_REQUIRED: Record<string, readonly string[]> = {
  text: ["type", "content"],
  attachment: ["type", "url"],
  widget: ["type", "widget"],
  "cursor-agent": ["type", "bcId"],
  "secret-request": ["type", "secret"]
};

export function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrap(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const record = value as JsonObject;
  if (typeof record["unwrap"] === "function") {
    try { return unwrap(record["unwrap"]("unsafe_always_allowed", {}), seen); } catch {}
  }
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (Array.isArray(value)) return value.map((item) => unwrap(item, seen));
  if (typeof record["toJSON"] === "function") {
    try {
      const json = record["toJSON"]();
      if (json !== value) return unwrap(json, seen);
    } catch {}
  }
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) result[key] = unwrap(child, seen);
  return result;
}

export function stringValue(value: unknown): string {
  const plain = unwrap(value);
  if (plain === null || plain === undefined) return "";
  if (typeof plain === "string") return plain;
  if (typeof plain === "number" || typeof plain === "boolean") return String(plain);
  try { return JSON.stringify(plain); } catch { return String(plain); }
}

function shortHash(value: unknown, length = 16): string {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

export function sanitizeToolId(value: unknown): string {
  const raw = stringValue(value) || "tool";
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
  return cleaned.length <= 64 ? cleaned : `${cleaned.slice(0, 47)}_${shortHash(raw)}`;
}

export function sanitizeToolName(value: unknown): string {
  return (stringValue(value) || "tool").replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
}

export function parseArguments(value: unknown): unknown {
  if (isRecord(value) || Array.isArray(value)) return unwrap(value);
  const text = stringValue(value).trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

function schemaFromTool(tool: SandTool): JsonObject {
  for (const key of ["parameters", "inputSchema", "schema"]) {
    try {
      const wrapper = tool && tool[key];
      if (!wrapper) continue;
      const wrapperRecord = isRecord(wrapper) ? wrapper : {};
      const schema = wrapperRecord["jsonSchema"] ?? wrapperRecord["inputSchema"] ?? wrapperRecord["schema"] ?? wrapper;
      const plain = unwrap(schema);
      if (isRecord(plain)) {
        return plain.type && plain.type !== "object"
          ? { type: "object", properties: { value: plain } }
          : { ...plain, type: "object", properties: isRecord(plain.properties) ? plain.properties : {} };
      }
    } catch {}
  }
  return { type: "object", properties: {} };
}

function codexDeliverySchema(name: unknown, schema: JsonObject): JsonObject {
  const normalized = sanitizeToolName(name).replace(/[_-]/g, "").toLowerCase();
  if (normalized !== "sendtouser" && normalized !== "sendmessage") return schema;
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const typeProperty = isRecord(properties["type"]) ? properties["type"] : undefined;
  const typeEnum = typeProperty?.["enum"];
  const supported = new Set<unknown>(Array.isArray(typeEnum) ? typeEnum : []);
  if (!Object.keys(SEND_VARIANTS).every((type) => supported.has(type))) return schema;
  return {
    type: "object",
    oneOf: Object.entries(SEND_VARIANTS).map(([type, fields]) => ({
      type: "object",
      properties: Object.fromEntries(fields.flatMap((field) => {
        if (field === "type") return [[field, { ...typeProperty, enum: [type], const: type }]];
        return isRecord(properties[field]) ? [[field, properties[field]]] : [];
      })),
      required: SEND_REQUIRED[type],
      additionalProperties: false
    }))
  };
}

export function convertTools(tools: unknown): JsonObject[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((raw) => {
    const tool = isRecord(raw) ? raw as SandTool : {};
    const name = sanitizeToolName(tool.name);
    return {
      type: "function",
      name,
      description: stringValue(tool.description || "").slice(0, 1024),
      parameters: codexDeliverySchema(name, schemaFromTool(tool)),
      strict: null
    };
  });
}

function partType(part: SandPart | undefined): string {
  return stringValue(part && (part.type || part.kind));
}

function textFromContent(content: unknown, includeReasoning = false): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringValue(content);
  const text = [];
  for (const part of content) {
    const item = isRecord(part) ? part as SandPart : {};
    const type = partType(item);
    if (["text", "input_text", "output_text"].includes(type)) text.push(stringValue(item.text ?? item.content));
    if (includeReasoning && ["reasoning", "thinking"].includes(type)) {
      text.push(stringValue(item.text ?? item.textDelta ?? item.thinking));
    }
  }
  return text.filter(Boolean).join("\n");
}

export function assistantMessageItem(text: string, ordinal = 0): JsonObject {
  return {
    type: "message",
    id: `msg_grok_${ordinal}_${shortHash(text, 20)}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }]
  };
}

function imageInput(part: SandPart): JsonObject | undefined {
  const imageUrl = isRecord(part.image_url) ? part.image_url["url"] : undefined;
  const value = imageUrl || part.url || part.image;
  if (!value) return undefined;
  return { type: "input_image", detail: part.detail || "auto", image_url: stringValue(value) };
}

function toolCallFromPart(part: SandPart): JsonObject {
  const nested = isRecord(part.function) ? part.function : {};
  return {
    type: "function_call",
    call_id: sanitizeToolId(part.toolCallId ?? part.tool_call_id ?? part.call_id ?? part.id),
    name: sanitizeToolName(part.toolName ?? part.tool_name ?? part.name ?? nested.name),
    arguments: JSON.stringify(parseArguments(part.args ?? part.arguments ?? part.input ?? nested.arguments))
  };
}

function toolOutputFromPart(part: SandPart, fallback: SandPart = {}): JsonObject {
  const result = part.result ?? part.content ?? part.output ?? part.value ?? fallback.content ?? fallback.result ?? "";
  const text = stringValue(result);
  return {
    type: "function_call_output",
    call_id: sanitizeToolId(part.toolCallId ?? part.tool_call_id ?? part.call_id ?? part.id ?? fallback.toolCallId ?? fallback.tool_call_id),
    output: part.isError || part.is_error ? `ERROR: ${text}` : text
  };
}

export function convertMessages(messages: unknown): { instructions: string; input: unknown[] } {
  const instructions = [];
  const input = [];
  let assistantOrdinal = 0;
  for (const raw of Array.isArray(messages) ? messages : []) {
    const unwrapped = unwrap(raw);
    const message = isRecord(unwrapped) ? unwrapped as SandMessage : {};
    const role = stringValue(message.role || "user");
    if (role === "system" || role === "developer") {
      const text = textFromContent(message.content, false);
      if (text) instructions.push(text);
      continue;
    }
    if (role === "tool" || role === "toolResult") {
      const parts = Array.isArray(message.content) ? message.content : [message];
      let emitted = false;
      for (const rawPart of parts) {
        const part = isRecord(rawPart) ? rawPart as SandPart : {};
        if (partType(part) === "tool-result" || partType(part) === "tool_result" || rawPart === message) {
          input.push(toolOutputFromPart(part, message));
          emitted = true;
        }
      }
      if (!emitted) input.push(toolOutputFromPart(message));
      continue;
    }
    if (role === "assistant") {
      const text = textFromContent(message.content, false);
      if (text) input.push(assistantMessageItem(text, assistantOrdinal++));
      const parts = [
        ...(Array.isArray(message.content) ? message.content : []),
        ...(Array.isArray(message.toolCalls) ? message.toolCalls : []),
        ...(Array.isArray(message.tool_calls) ? message.tool_calls : [])
      ];
      for (const rawPart of parts) {
        const part = isRecord(rawPart) ? rawPart as SandPart : {};
        const type = partType(part);
        if (["tool-call", "tool_use", "function_call"].includes(type) || part.function) {
          input.push(toolCallFromPart(part));
        }
      }
      continue;
    }
    const content = message.content;
    if (Array.isArray(content)) {
      const parts = [];
      for (const rawPart of content) {
        const part = isRecord(rawPart) ? rawPart as SandPart : {};
        const type = partType(part);
        if (["text", "input_text", "output_text"].includes(type)) {
          const text = stringValue(part.text ?? part.content);
          if (text) parts.push({ type: "input_text", text });
        } else if (["image", "image_url", "input_image"].includes(type)) {
          const image = imageInput(part);
          if (image) parts.push(image);
        }
      }
      if (parts.length) input.push({ role: "user", content: parts });
    } else {
      const text = stringValue(content);
      if (text) input.push({ role: "user", content: [{ type: "input_text", text }] });
    }
  }
  if (input.length === 0) input.push({ role: "user", content: [{ type: "input_text", text: "(continue)" }] });
  return { instructions: instructions.join("\n\n") || "You are a helpful assistant.", input };
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
  if (route.reasoningEffort !== "off" && route.reasoningEffort !== "none") {
    body.reasoning = { effort: route.reasoningEffort, summary: "auto" };
  }
  return body;
}
