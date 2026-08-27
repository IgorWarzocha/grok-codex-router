# Grok Codex Router

Grok Codex Router keeps Grok Bot's native interface, tools, permissions, and agent loop while moving inference onto the first-party ChatGPT Codex Responses transport.

It is not an OpenAI-compatible Chat Completions proxy. The router speaks Codex Responses directly, reuses your existing OAuth account, preserves cached WebSocket continuation, supplies stable prompt-cache identity, and resolves model plus reasoning effort per Grok Bot agent.

## Requirements

- Grok Bot running inside a Sand VM
- Node.js 22.19 or newer
- A valid OpenAI Codex OAuth account already stored by Pi or Codex CLI

The router never starts login. It reads one selected credential store and refreshes that store atomically when needed. Tokens and request bodies are never written to router logs.

Switch credential ownership only to another store that is already authenticated:

```bash
grok-codex-router auth-store pi
# or
grok-codex-router auth-store codex
```

## Install

```bash
git clone https://github.com/IgorWarzocha/grok-codex-router.git ~/grok-codex-router
cd ~/grok-codex-router
npm ci
npm run check
npm link
grok-codex-router install
```

`install` creates `~/sand-data/grok-codex-router.json`, patches the current Sand host, and restarts it. The default root route is `gpt-5.6-sol` with `high` reasoning.

The host patch only propagates immutable agent identity and workload class into the inference session. Routing, OAuth, request translation, continuation, and recovery stay in this repository.

## Route agents

Agent names are resolved to immutable IDs before the config is written.

```bash
grok-codex-router route Howaclawa gpt-5.6-sol high
grok-codex-router route Disca gpt-5.6-sol medium
grok-codex-router routes
grok-codex-router restart-host
```

An explicit agent route applies to ordinary root turns. Other inference workloads use separate class routes:

```bash
grok-codex-router class summarization gpt-5.6-sol medium
grok-codex-router class subagent gpt-5.6-sol high
grok-codex-router class automation gpt-5.6-sol medium
```

Supported classes are `summarization`, `subagent`, `browser`, `computer`, `automation`, and `group`. This separation prevents an expensive root-agent route from leaking into background work.

## Verify

```bash
grok-codex-router status
grok-codex-router verify Howaclawa
```

`verify` performs a real two-request tool round-trip. The second request must reuse the cached WebSocket and send only the new tool-result tail. Router diagnostics are written to `~/sand-data/grok-codex-router.log` without prompts, tool arguments, or credentials.

A complete deployment check also includes a native Grok Bot turn through its UI. That turn should invoke a harmless native tool, deliver its result through Grok Bot's native delivery tool, and leave the agent idle.

## Recover after a Sand update

```bash
cd ~/grok-codex-router
git pull --ff-only
npm ci
npm run check
grok-codex-router recover
```

The patcher is idempotent and checks unique structural anchors. It refuses an unfamiliar host bundle instead of guessing. A host backup is retained at `~/sand-host/host-main.cjs.grok-codex-router-bak`.

## Transport behavior

- Direct `wss://chatgpt.com/backend-api/codex/responses`
- Stable prompt-cache key, session ID, thread ID, and client metadata per agent workload
- Connection-scoped `previous_response_id` only after validating the reconstructed history prefix
- Initial WebSocket request plus five fresh retries by default
- Sticky SSE fallback after WebSocket upgrade failure, oversized frames, or exhausted retries
- Three-minute shared retry budget for provider throttling
- Provider-reported cached, uncached, and output token diagnostics

The ChatGPT endpoint requires `store: false`. Continuation therefore remains connection-scoped. A dead socket falls back to a full request with the same stable cache key.

## Remove

Restore the host backup, then restart the host:

```bash
cp ~/sand-host/host-main.cjs.grok-codex-router-bak ~/sand-host/host-main.cjs
grok-codex-router restart-host
```

The router does not modify Grok Bot transcripts, profiles, tools, or permissions.
