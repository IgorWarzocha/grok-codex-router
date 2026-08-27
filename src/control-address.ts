const DEFAULT_CONTROL_PORT = 21_371;

export function controlPort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.SAND_CODEX_ROUTER_PORT || DEFAULT_CONTROL_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SAND_CODEX_ROUTER_PORT must be an integer from 1 to 65535");
  }
  return port;
}

export function controlUrl(env: NodeJS.ProcessEnv = process.env): string {
  return "http://127.0.0.1:" + controlPort(env);
}
