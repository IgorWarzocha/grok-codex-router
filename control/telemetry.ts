import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

interface UsageSummary {
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface TelemetrySnapshot {
  summary: UsageSummary;
  byAgent: Array<UsageSummary & { agentId: string; model: string }>;
  recent: Array<Record<string, unknown>>;
}

function dataRoot(): string {
  return process.env.SAND_DATA_ROOT || path.join(os.homedir(), "sand-data");
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, 500) : null;
}

function booleanValue(value: unknown): number | null {
  return typeof value === "boolean" ? Number(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS events (",
  "  id INTEGER PRIMARY KEY,",
  "  source TEXT NOT NULL,",
  "  source_offset INTEGER NOT NULL,",
  "  ts TEXT, type TEXT, agent_id TEXT, workload TEXT, model TEXT, reasoning_effort TEXT,",
  "  transport TEXT, session_id TEXT, socket_reused INTEGER, continuation TEXT,",
  "  input_tokens INTEGER, cached_input_tokens INTEGER, cache_write_input_tokens INTEGER,",
  "  output_tokens INTEGER, duration_ms INTEGER, attempt INTEGER, code TEXT, param TEXT,",
  "  status INTEGER, full_input_items INTEGER, sent_input_items INTEGER,",
  "  UNIQUE(source, source_offset)",
  ");",
  "CREATE INDEX IF NOT EXISTS events_type_id ON events(type, id);",
  "CREATE INDEX IF NOT EXISTS events_agent_id ON events(agent_id, id);"
].join("\n");

const INSERT_EVENT = [
  "INSERT OR IGNORE INTO events (",
  "  source, source_offset, ts, type, agent_id, workload, model, reasoning_effort,",
  "  transport, session_id, socket_reused, continuation, input_tokens,",
  "  cached_input_tokens, cache_write_input_tokens, output_tokens, duration_ms,",
  "  attempt, code, param, status, full_input_items, sent_input_items",
  ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
].join("\n");

export class TelemetryStore {
  private readonly database: Database;
  private readonly sourceFile: string;
  private sourceIdentity = "";
  private sourceOffset = 0;

  constructor() {
    const root = dataRoot();
    fs.mkdirSync(root, { recursive: true });
    this.sourceFile = process.env.SAND_CODEX_ROUTER_LOG || path.join(root, "grok-codex-router.log");
    this.database = new Database(path.join(root, "grok-codex-router-telemetry.sqlite"), { create: true });
    this.database.exec("PRAGMA journal_mode=WAL");
    this.database.exec("PRAGMA synchronous=NORMAL");
    this.database.exec(SCHEMA);
    const identity = this.database.query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key = ?").get("sourceIdentity");
    const offset = this.database.query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key = ?").get("sourceOffset");
    this.sourceIdentity = identity?.value || "";
    this.sourceOffset = Number(offset?.value) || 0;
  }

  private saveCursor(): void {
    const statement = this.database.query("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)");
    statement.run("sourceIdentity", this.sourceIdentity);
    statement.run("sourceOffset", String(this.sourceOffset));
  }

  ingest(): void {
    let stat: fs.Stats;
    try { stat = fs.statSync(this.sourceFile); } catch { return; }
    const fileIdentity = stat.dev + ":" + stat.ino;
    const sameFile = this.sourceIdentity === fileIdentity || this.sourceIdentity.startsWith(fileIdentity + ":");
    if (!sameFile || stat.size < this.sourceOffset) {
      this.sourceIdentity = sameFile ? fileIdentity + ":" + stat.mtimeMs : fileIdentity;
      this.sourceOffset = 0;
      this.saveCursor();
    }
    if (stat.size <= this.sourceOffset) return;
    const length = Math.min(stat.size - this.sourceOffset, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const descriptor = fs.openSync(this.sourceFile, "r");
    try { fs.readSync(descriptor, buffer, 0, length, this.sourceOffset); }
    finally { fs.closeSync(descriptor); }
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return;
    const complete = buffer.subarray(0, lastNewline + 1).toString("utf8");
    let relativeOffset = 0;
    const insert = this.database.query(INSERT_EVENT);
    for (const line of complete.split("\n")) {
      const lineBytes = Buffer.byteLength(line) + 1;
      if (line) {
        try {
          const event = JSON.parse(line) as unknown;
          if (isRecord(event)) {
            insert.run(
              this.sourceIdentity,
              this.sourceOffset + relativeOffset,
              stringValue(event["ts"]),
              stringValue(event["type"]),
              stringValue(event["agentId"]),
              stringValue(event["workload"]),
              stringValue(event["model"]),
              stringValue(event["reasoningEffort"]),
              stringValue(event["transport"]),
              stringValue(event["sessionId"]),
              booleanValue(event["socketReused"]),
              stringValue(event["continuation"]),
              numberValue(event["inputTokens"]),
              numberValue(event["cachedInputTokens"]),
              numberValue(event["cacheWriteInputTokens"]),
              numberValue(event["outputTokens"]),
              numberValue(event["durationMs"]),
              numberValue(event["attempt"]),
              stringValue(event["code"]),
              stringValue(event["param"]),
              numberValue(event["status"]),
              numberValue(event["fullInputItems"]),
              numberValue(event["sentInputItems"])
            );
          }
        } catch {}
      }
      relativeOffset += lineBytes;
    }
    this.sourceOffset += lastNewline + 1;
    this.saveCursor();
  }

  snapshot(): TelemetrySnapshot {
    this.ingest();
    const totalsSql = [
      "SELECT COUNT(*) AS turns, COALESCE(SUM(input_tokens), 0) AS inputTokens,",
      "COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,",
      "COALESCE(SUM(cache_write_input_tokens), 0) AS cacheWriteInputTokens,",
      "COALESCE(SUM(output_tokens), 0) AS outputTokens,",
      "COALESCE(SUM(duration_ms), 0) AS durationMs",
      "FROM events WHERE type IN ('turn', 'usage')"
    ].join(" ");
    const totals = this.database.query<Record<string, number | null>, []>(totalsSql).get() || {};
    const byAgentSql = [
      "SELECT COALESCE(agent_id, 'unidentified') AS agentId, COALESCE(model, 'unknown') AS model,",
      "COUNT(*) AS turns, COALESCE(SUM(input_tokens), 0) AS inputTokens,",
      "COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,",
      "COALESCE(SUM(cache_write_input_tokens), 0) AS cacheWriteInputTokens,",
      "COALESCE(SUM(output_tokens), 0) AS outputTokens, COALESCE(SUM(duration_ms), 0) AS durationMs",
      "FROM events WHERE type IN ('turn', 'usage') GROUP BY agent_id, model ORDER BY MAX(id) DESC"
    ].join(" ");
    const byAgent = this.database.query<Record<string, string | number | null>, []>(byAgentSql).all().map((row) => ({
      agentId: String(row["agentId"]),
      model: String(row["model"]),
      turns: Number(row["turns"]),
      inputTokens: Number(row["inputTokens"]),
      cachedInputTokens: Number(row["cachedInputTokens"]),
      cacheWriteInputTokens: Number(row["cacheWriteInputTokens"]),
      outputTokens: Number(row["outputTokens"]),
      durationMs: Number(row["durationMs"])
    }));
    const recentSql = [
      "SELECT ts, type, agent_id AS agentId, workload, model, reasoning_effort AS reasoningEffort,",
      "transport, session_id AS sessionId, socket_reused AS socketReused, continuation,",
      "input_tokens AS inputTokens, cached_input_tokens AS cachedInputTokens,",
      "output_tokens AS outputTokens, duration_ms AS durationMs, attempt, code, param, status,",
      "full_input_items AS fullInputItems, sent_input_items AS sentInputItems",
      "FROM events ORDER BY id DESC LIMIT ?"
    ].join(" ");
    const recent = this.database.query<Record<string, unknown>, [number]>(recentSql).all(120);
    return {
      summary: {
        turns: Number(totals["turns"] || 0),
        inputTokens: Number(totals["inputTokens"] || 0),
        cachedInputTokens: Number(totals["cachedInputTokens"] || 0),
        cacheWriteInputTokens: Number(totals["cacheWriteInputTokens"] || 0),
        outputTokens: Number(totals["outputTokens"] || 0),
        durationMs: Number(totals["durationMs"] || 0)
      },
      byAgent,
      recent
    };
  }

  close(): void {
    this.database.close();
  }
}
