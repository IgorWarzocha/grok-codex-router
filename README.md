# Grok Codex Router

Grok Codex Router keeps Grok Bot's native interface, tools, permissions, and agent loop while moving inference onto the first-party ChatGPT Codex Responses transport.

It is not an OpenAI-compatible Chat Completions proxy. The router speaks Codex Responses directly, reuses your existing OAuth account, preserves cached WebSocket continuation, supplies stable prompt-cache identity, and resolves model plus reasoning effort per agent and Grok Bot workload.

## Requirements

- Grok Bot running inside a Sand VM
- Node.js 22.19 or newer
- Bun 1.4 or newer
- A valid OpenAI Codex OAuth account already stored by Pi or Codex CLI

The router never starts login. It reads one selected credential store and refreshes that store atomically when needed. Tokens and request bodies are never written to router logs.

## Install

```bash
git clone https://github.com/IgorWarzocha/grok-codex-router.git ~/grok-codex-router
cd ~/grok-codex-router
./install.sh
```

The installer uses the locked dependencies, runs every check, links the management command, selects an existing authenticated OAuth store, patches the current Sand host, starts the control service, restarts through Sand's native supervisor, and completes a real cached tool round-trip.

It does not start OAuth login. If neither supported credential store is valid, installation stops and asks for human authentication.

Open `http://127.0.0.1:3210` in the VM browser after installation.

## Control UI

The local control UI discovers Grok Bot profiles from the live Sand data directory. Display names can change without breaking routes because settings remain keyed by immutable profile ID.

The UI manages:

- Default model and reasoning
- Per-agent overrides
- Summarization, subagent, browser, computer, automation, and group routes
- Cached WebSocket, WebSocket, and SSE transport settings
- Existing Pi or Codex OAuth store selection
- Sanitized usage totals, cache share, inference time, and recent transport activity
- Host compatibility, recovery, restart, and issue diagnostics

The server binds only to `127.0.0.1`. Mutations require an installation-specific control token delivered only to the local UI. Telemetry storage accepts a fixed safe field list and excludes prompts, message bodies, tool arguments, credentials, account identifiers, and authorization headers.

## Service behavior

Sand VMs do not run systemd. They use `tini`, `sand-exit-watch`, and Sand's own host supervisor.

The installer adds a small checked bootstrap to the patched host. That bootstrap starts a detached router supervisor, which keeps the Bun control service running. The service survives Sand host restarts and bundle swaps. Host restart requests go back through Sand's native idle-aware supervisor instead of killing and replacing the process directly.

The inference router does not depend on the UI. Existing turns continue if the control service is stopped.

## Automatic host recovery

The control service checks each changed Sand host bundle before touching it.

1. An already patched compatible bundle is left alone.
2. A compatible unpatched update receives the idempotent host patch.
3. Sand's native supervisor waits for active turns to become idle and restarts the host.
4. The service records that the patched host loaded successfully.
5. An unfamiliar bundle is left untouched and reported as incompatible.

The patcher requires unique structural anchors, one marker set, a pristine backup, and a compiled router entry. It never guesses at a changed host shape.

For an incompatible update:

```bash
cd ~/grok-codex-router
git pull --ff-only
./install.sh
grok-codex-router diagnose > /tmp/grok-codex-router-report.md
```

The bundled skill at `.agents/skills/grok-codex-router/` tells Codex and compatible agents how to investigate a new host safely, prepare a tested fork, and report the sanitized compatibility result at [GitHub issues](https://github.com/IgorWarzocha/grok-codex-router/issues/new). Never attach the proprietary host bundle.

## CLI operation

The UI is the ordinary management surface. The CLI remains available for recovery and automation.

```bash
grok-codex-router status
grok-codex-router agents
grok-codex-router routes
grok-codex-router route "Agent Name" gpt-5.6-sol high
grok-codex-router class summarization gpt-5.6-sol medium
grok-codex-router recover
```

Agent names are resolved against live profiles before immutable IDs are written. An explicit agent route applies to ordinary root turns. Background workloads always use their own explicit class route.

Switch credential ownership only to another store that is already authenticated:

```bash
grok-codex-router auth-store pi
# or
grok-codex-router auth-store codex
```

## Verify

```bash
grok-codex-router status
grok-codex-router verify
```

`verify` performs a real two-request tool round-trip on a synthetic diagnostic identity. The second request must reuse the cached WebSocket and send only the new tool-result tail.

A complete deployment check also includes a native Grok Bot turn through its UI. That turn should invoke a harmless native tool, deliver its result through Grok Bot's native delivery tool, and leave the agent idle.

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

Stop the router service, restore the pristine host backup, and restart through Sand's supervisor:

```bash
grok-codex-router service-stop
cp ~/sand-host/host-main.cjs.grok-codex-router-bak ~/sand-host/host-main.cjs
grok-codex-router restart-host
```

The router does not modify Grok Bot transcripts, profiles, tools, or permissions.
