import {
  isRecord,
  parseArguments,
  sanitizeToolId,
  sanitizeToolName,
  stringValue,
  unwrapSandValue,
  type JsonObject
} from "./sand-values.js";

export interface ToolWirePart extends JsonObject {
  type?: unknown;
  kind?: unknown;
  content?: unknown;
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

interface SandTool extends JsonObject {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  inputSchema?: unknown;
  schema?: unknown;
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

function schemaFromTool(tool: SandTool): JsonObject {
  for (const key of ["parameters", "inputSchema", "schema"]) {
    try {
      const wrapper = tool[key];
      if (!wrapper) continue;
      const wrapperRecord = isRecord(wrapper) ? wrapper : {};
      const schema = wrapperRecord["jsonSchema"] ?? wrapperRecord["inputSchema"] ?? wrapperRecord["schema"] ?? wrapper;
      const plain = unwrapSandValue(schema);
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

export function toolCallItem(part: ToolWirePart): JsonObject {
  const nested = isRecord(part.function) ? part.function : {};
  return {
    type: "function_call",
    call_id: sanitizeToolId(part.toolCallId ?? part.tool_call_id ?? part.call_id ?? part.id),
    name: sanitizeToolName(part.toolName ?? part.tool_name ?? part.name ?? nested.name),
    arguments: JSON.stringify(parseArguments(part.args ?? part.arguments ?? part.input ?? nested.arguments))
  };
}

export function toolOutputItem(part: ToolWirePart, fallback: ToolWirePart = {}): JsonObject {
  const result = part.result ?? part.content ?? part.output ?? part.value ?? fallback.content ?? fallback.result ?? "";
  const text = stringValue(result);
  return {
    type: "function_call_output",
    call_id: sanitizeToolId(
      part.toolCallId ?? part.tool_call_id ?? part.call_id ?? part.id ??
      fallback.toolCallId ?? fallback.tool_call_id
    ),
    output: part.isError || part.is_error ? `ERROR: ${text}` : text
  };
}
