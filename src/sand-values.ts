import crypto from "node:crypto";

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unwrapSandValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value)) return undefined;
  seen.add(value);

  const record = value as JsonObject;
  if (typeof record["unwrap"] === "function") {
    try {
      return unwrapSandValue(record["unwrap"]("unsafe_always_allowed", {}), seen);
    } catch {}
  }
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (Array.isArray(value)) return value.map((item) => unwrapSandValue(item, seen));
  if (typeof record["toJSON"] === "function") {
    try {
      const json = record["toJSON"]();
      if (json !== value) return unwrapSandValue(json, seen);
    } catch {}
  }

  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) result[key] = unwrapSandValue(child, seen);
  return result;
}

export function stringValue(value: unknown): string {
  const plain = unwrapSandValue(value);
  if (plain === null || plain === undefined) return "";
  if (typeof plain === "string") return plain;
  if (typeof plain === "number" || typeof plain === "boolean") return String(plain);
  try {
    return JSON.stringify(plain);
  } catch {
    return String(plain);
  }
}

export function shortHash(value: unknown, length = 16): string {
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
  if (isRecord(value) || Array.isArray(value)) return unwrapSandValue(value);
  const text = stringValue(value).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}
