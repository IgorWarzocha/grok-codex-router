import {
  isRecord,
  shortHash,
  stringValue,
  unwrapSandValue,
  type JsonObject
} from "./sand-values.js";
import {
  toolCallItem,
  toolOutputItem,
  type ToolWirePart
} from "./tool-wire.js";

interface SandPart extends ToolWirePart {
  text?: unknown;
  textDelta?: unknown;
  thinking?: unknown;
  image_url?: unknown;
  url?: unknown;
  image?: unknown;
  data?: unknown;
  mimeType?: unknown;
  mime_type?: unknown;
  detail?: unknown;
}

interface SandMessage extends SandPart {
  role?: unknown;
  toolCalls?: unknown;
  tool_calls?: unknown;
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

function imageInput(part: SandPart): JsonObject {
  const imageUrl = isRecord(part.image_url) ? part.image_url["url"] : part.image_url;
  const value = stringValue(imageUrl || part.url || part.image || part.data).trim();
  const mimeType = stringValue(part.mimeType || part.mime_type).trim().toLowerCase();
  const dataUrl = value && !/^(?:data:|https?:\/\/)/i.test(value) && mimeType.startsWith("image/")
    ? `data:${mimeType};base64,${value}`
    : value;
  if (/^https?:\/\//i.test(dataUrl) || /^data:image\/[^;,]+;base64,[a-z0-9+/]*={0,2}$/i.test(dataUrl)) {
    return { type: "input_image", detail: part.detail || "auto", image_url: dataUrl };
  }
  return { type: "input_text", text: "image content omitted because its source is not available to Codex" };
}

export function convertMessages(messages: unknown): { instructions: string; input: unknown[] } {
  const instructions = [];
  const input = [];
  let assistantOrdinal = 0;
  for (const raw of Array.isArray(messages) ? messages : []) {
    const unwrapped = unwrapSandValue(raw);
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
          input.push(toolOutputItem(part, message));
          emitted = true;
        }
      }
      if (!emitted) input.push(toolOutputItem(message));
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
          input.push(toolCallItem(part));
        }
      }
      continue;
    }
    if (Array.isArray(message.content)) {
      const parts = [];
      for (const rawPart of message.content) {
        const part = isRecord(rawPart) ? rawPart as SandPart : {};
        const type = partType(part);
        if (["text", "input_text", "output_text"].includes(type)) {
          const text = stringValue(part.text ?? part.content);
          if (text) parts.push({ type: "input_text", text });
        } else if (["image", "image_url", "input_image"].includes(type)) {
          parts.push(imageInput(part));
        }
      }
      if (parts.length) input.push({ role: "user", content: parts });
    } else {
      const text = stringValue(message.content);
      if (text) input.push({ role: "user", content: [{ type: "input_text", text }] });
    }
  }
  if (input.length === 0) input.push({ role: "user", content: [{ type: "input_text", text: "(continue)" }] });
  return { instructions: instructions.join("\n\n") || "You are a helpful assistant.", input };
}
