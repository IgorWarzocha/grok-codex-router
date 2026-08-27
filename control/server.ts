import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { discoverAgents } from "../src/agents.js";
import { loadConfig, validateConfig, writeConfig } from "../src/config.js";
import { issueReport } from "../src/diagnostics.js";
import { credentialStatus } from "../src/oauth.js";
import { requestHostRestart } from "../src/sand-supervisor.js";
import { HostReconciler } from "./reconcile.js";
import { TelemetryStore } from "./telemetry.js";

process.umask(0o077);

const port = Number(process.env.SAND_CODEX_ROUTER_PORT || 3210);
const routerHome = process.env.SAND_CODEX_ROUTER_HOME || path.resolve(__dirname, "..", "..");
const publicRoot = path.join(routerHome, "ui");
const dataRoot = process.env.SAND_DATA_ROOT || path.join(os.homedir(), "sand-data");
const tokenFile = path.join(dataRoot, "grok-codex-router-control-token");
const issueUrl = "https://github.com/IgorWarzocha/grok-codex-router/issues/new";
const reconciler = new HostReconciler();
const telemetry = new TelemetryStore();
let manualAction: { name: string; state: "running" | "complete" | "failed"; message: string } | null = null;

function controlToken(): string {
  try {
    const existing = fs.readFileSync(tokenFile, "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  } catch {}
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
  return token;
}

const token = controlToken();

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(value));
}

function text(response: http.ServerResponse, status: number, value: string, contentType = "text/plain; charset=utf-8"): void {
  response.writeHead(status, securityHeaders(contentType));
  response.end(value);
}

function state(): Record<string, unknown> {
  const config = loadConfig();
  const discovered = discoverAgents();
  const names = new Map(discovered.map((agent) => [agent.id, agent.name]));
  const agents = [
    ...discovered.map((agent) => ({ ...agent, available: true })),
    ...Object.keys(config.agents)
      .filter((id) => !names.has(id))
      .map((id) => ({ id, name: "Unavailable profile", available: false }))
  ];
  let auth: Record<string, unknown>;
  try {
    const status = credentialStatus(config.authStore);
    auth = {
      ok: status.validForMs > 0,
      store: status.store,
      validForMinutes: Math.floor(status.validForMs / 60000)
    };
  } catch (error: unknown) {
    auth = { ok: false, store: config.authStore, message: error instanceof Error ? error.message : String(error) };
  }
  const metrics = telemetry.snapshot();
  return {
    service: {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      runtime: "Bun " + ((process.versions as Record<string, string | undefined>)["bun"] || "compatibility mode")
    },
    host: reconciler.snapshot(),
    auth,
    config,
    agents: agents.map((agent) => ({
      ...agent,
      route: config.agents[agent.id] || null,
      effectiveRoute: config.agents[agent.id] || config.default
    })),
    telemetry: {
      ...metrics,
      byAgent: metrics.byAgent.map((entry) => ({
        ...entry,
        agentName: names.get(entry.agentId) || (entry.agentId === "unidentified" ? "Legacy, before attribution" : entry.agentId)
      }))
    },
    manualAction,
    issueUrl
  };
}

async function requestBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function authorized(request: http.IncomingMessage): boolean {
  const origin = request.headers.origin;
  const allowedOrigins = new Set([
    "http://127.0.0.1:" + port,
    "http://localhost:" + port
  ]);
  return request.headers["x-grok-codex-router-token"] === token &&
    (origin === undefined || allowedOrigins.has(origin));
}

function localHost(request: http.IncomingMessage): boolean {
  const host = request.headers.host?.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" ||
    host === "127.0.0.1:" + port || host === "localhost:" + port;
}

function runManualAction(name: string, operation: () => Promise<void>): void {
  manualAction = { name, state: "running", message: name + " started." };
  void operation().then(() => {
    manualAction = { name, state: "complete", message: name + " completed." };
  }, (error: unknown) => {
    manualAction = { name, state: "failed", message: error instanceof Error ? error.message : String(error) };
  });
}

async function api(request: http.IncomingMessage, response: http.ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith("/api/")) return false;
  if (!authorized(request)) {
    json(response, 403, { error: "control token rejected" });
    return true;
  }
  if (request.method === "GET" && pathname === "/api/state") {
    json(response, 200, state());
    return true;
  }
  if (request.method === "GET" && pathname === "/api/issue-report") {
    text(response, 200, issueReport());
    return true;
  }
  if (request.method === "PUT" && pathname === "/api/config") {
    const current = loadConfig();
    const next = validateConfig(await requestBody(request));
    if (next.authStore !== current.authStore) credentialStatus(next.authStore);
    writeConfig(next);
    json(response, 200, { ok: true, config: next });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/recover") {
    runManualAction("Compatibility recovery", () => reconciler.reconcile(true));
    json(response, 202, { ok: true });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/restart") {
    runManualAction("Sand host restart", async () => {
      await requestHostRestart({ reason: "grok-codex-router control UI requested restart" });
    });
    json(response, 202, { ok: true });
    return true;
  }
  json(response, 404, { error: "unknown API route" });
  return true;
}

function publicFile(pathname: string): { file: string; contentType: string } | undefined {
  if (pathname === "/favicon.svg") return { file: path.join(publicRoot, "favicon.svg"), contentType: "image/svg+xml" };
  if (pathname === "/app.js") return { file: path.join(publicRoot, "app.js"), contentType: "text/javascript; charset=utf-8" };
  if (pathname === "/styles.css") return { file: path.join(publicRoot, "styles.css"), contentType: "text/css; charset=utf-8" };
  if (pathname === "/" || pathname === "/index.html") return { file: path.join(publicRoot, "index.html"), contentType: "text/html; charset=utf-8" };
  return undefined;
}

const server = http.createServer((request, response) => {
  void (async () => {
    if (!localHost(request)) {
      text(response, 421, "Local host required");
      return;
    }
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (await api(request, response, url.pathname)) return;
    const asset = publicFile(url.pathname);
    if (!asset) {
      text(response, 404, "Not found");
      return;
    }
    let body = fs.readFileSync(asset.file);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      body = Buffer.from(body.toString("utf8").replace("__CONTROL_TOKEN__", token));
    }
    response.writeHead(200, securityHeaders(asset.contentType));
    response.end(body);
  })().catch((error: unknown) => {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

reconciler.start();
const ingestTimer = setInterval(() => telemetry.ingest(), 1000);
server.listen(port, "127.0.0.1", () => {
  console.log("[grok-codex-router] control UI listening at http://127.0.0.1:" + port);
});

const stop = () => {
  clearInterval(ingestTimer);
  reconciler.stop();
  telemetry.close();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
