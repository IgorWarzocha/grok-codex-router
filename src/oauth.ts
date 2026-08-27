import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const JWT_CLAIM = "https://api.openai.com/auth";
const REFRESH_SKEW_MS = 120000;

export interface Credentials {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

interface CredentialStore {
  kind: "pi" | "codex";
  file: string;
  document: Record<string, unknown>;
  credentials: Credentials;
}

interface OAuthRefreshPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

interface CandidateCredentials {
  access?: string | undefined;
  refresh?: string | undefined;
  expires?: number | undefined;
  accountId?: string | undefined;
}

function stores(): Record<"pi" | "codex", string> {
  return {
    pi: path.join(os.homedir(), ".pi", "agent", "auth.json"),
    codex: path.join(os.homedir(), ".codex", "auth.json")
  };
}

function decodeJwt(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1] || "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

export function accountIdFromToken(token: string): string | undefined {
  const auth = decodeJwt(token)[JWT_CLAIM];
  return auth && typeof auth === "object" && "chatgpt_account_id" in auth &&
    typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}

function expiryFromToken(token: string): number {
  const exp = decodeJwt(token).exp;
  return typeof exp === "number" ? exp * 1000 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStore(kind: "pi" | "codex"): CredentialStore {
  const file = stores()[kind];
  let document: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("credential document is not an object");
    document = parsed;
  } catch (error: unknown) {
    throw new Error(`OpenAI OAuth store is unavailable at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let credentials: CandidateCredentials | undefined;
  if (kind === "pi") {
    const entry = document["openai-codex"];
    if (isRecord(entry)) {
      credentials = {
        access: typeof entry["access"] === "string" ? entry["access"] : undefined,
        refresh: typeof entry["refresh"] === "string" ? entry["refresh"] : undefined,
        expires: typeof entry["expires"] === "number" ? entry["expires"] : undefined,
        accountId: typeof entry["accountId"] === "string" ? entry["accountId"] : undefined
      };
    }
  } else {
    const tokens = document["tokens"];
    if (isRecord(tokens)) {
      credentials = {
        access: typeof tokens["access_token"] === "string" ? tokens["access_token"] : undefined,
        refresh: typeof tokens["refresh_token"] === "string" ? tokens["refresh_token"] : undefined,
        expires: typeof tokens["access_token"] === "string" ? expiryFromToken(tokens["access_token"]) : undefined,
        accountId: typeof tokens["account_id"] === "string" ? tokens["account_id"] : undefined
      };
    }
  }
  if (!credentials || typeof credentials.access !== "string" || typeof credentials.refresh !== "string") {
    throw new Error(`OpenAI OAuth credentials are missing from ${file}`);
  }
  const accountId = typeof credentials.accountId === "string" && credentials.accountId ||
    accountIdFromToken(credentials.access);
  if (!accountId) throw new Error("OpenAI OAuth access token has no ChatGPT account ID");
  return {
    kind,
    file,
    document,
    credentials: {
      access: credentials.access,
      refresh: credentials.refresh,
      expires: Number(credentials.expires) || expiryFromToken(credentials.access),
      accountId
    }
  };
}

function atomicWrite(file: string, document: Record<string, unknown>): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function writeRefreshed(store: CredentialStore, next: Credentials): void {
  if (store.kind === "pi") {
    const previous = isRecord(store.document["openai-codex"]) ? store.document["openai-codex"] : {};
    store.document["openai-codex"] = {
      ...previous,
      access: next.access,
      refresh: next.refresh,
      expires: next.expires,
      accountId: next.accountId
    };
  } else {
    const previous = isRecord(store.document["tokens"]) ? store.document["tokens"] : {};
    store.document["tokens"] = {
      ...previous,
      access_token: next.access,
      refresh_token: next.refresh,
      account_id: next.accountId
    };
    store.document.last_refresh = new Date().toISOString();
  }
  atomicWrite(store.file, store.document);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRefreshLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const lock = `${file}.grok-codex-router.lock`;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      try {
        fs.writeFileSync(fd, String(process.pid));
        return await operation();
      } finally {
        fs.closeSync(fd);
        try { fs.unlinkSync(lock); } catch {}
      }
    } catch (error: unknown) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > 60000) fs.unlinkSync(lock);
      } catch {}
      await sleep(100);
    }
  }
  throw new Error("timed out waiting for the OpenAI OAuth refresh lock");
}

async function refresh(store: CredentialStore, signal?: AbortSignal): Promise<Credentials> {
  return withRefreshLock(store.file, async () => {
    const latest = readStore(store.kind);
    if (latest.credentials.expires > Date.now() + REFRESH_SKEW_MS) return latest.credentials;
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: latest.credentials.refresh,
        client_id: CLIENT_ID
      }),
      ...(signal ? { signal } : {})
    });
    if (!response.ok) {
      throw new Error(`OpenAI OAuth refresh failed with HTTP ${response.status}`);
    }
    const payload = await response.json() as OAuthRefreshPayload;
    if (typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string" ||
        typeof payload.expires_in !== "number") {
      throw new Error("OpenAI OAuth refresh response is missing required fields");
    }
    const accountId = accountIdFromToken(payload.access_token);
    if (!accountId) throw new Error("refreshed OpenAI OAuth token has no ChatGPT account ID");
    const next: Credentials = {
      access: payload.access_token,
      refresh: payload.refresh_token,
      expires: Date.now() + payload.expires_in * 1000,
      accountId
    };
    writeRefreshed(latest, next);
    return next;
  });
}

export async function getCredentials(kind: "pi" | "codex" = "pi", signal?: AbortSignal): Promise<Credentials> {
  const store = readStore(kind);
  if (store.credentials.expires > Date.now() + REFRESH_SKEW_MS) return store.credentials;
  return refresh(store, signal);
}

export function credentialStatus(kind: "pi" | "codex" = "pi"): {
  store: "pi" | "codex";
  file: string;
  validForMs: number;
  accountIdPresent: boolean;
} {
  const store = readStore(kind);
  return {
    store: kind,
    file: store.file,
    validForMs: Math.max(0, store.credentials.expires - Date.now()),
    accountIdPresent: Boolean(store.credentials.accountId)
  };
}
