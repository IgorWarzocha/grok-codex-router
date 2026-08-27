---
name: grok-codex-router
description: "Read before installing, recovering, routing, or diagnosing this repository's Codex inference integration for Grok Bot."
---

1. Discover and load applicable OAuth inference, prompt-caching, dependency, and review skills before work.
2. Work from this checkout. `src/` is canonical and `dist/` is generated.
3. Reuse the configured `pi` or `codex` OAuth store. Never start login unless `grok-codex-router status` or a real provider request proves the account invalid.
4. Use `grok-codex-router route AGENT MODEL EFFORT` for root agents. Use `class` for summarization, subagent, browser, computer, automation, and group workloads.
5. Rebuild and run `grok-codex-router patch-host`. Stop when the patcher rejects an unfamiliar bundle. Do not hand-edit `host-main.cjs`.
6. Restart, run `grok-codex-router verify AGENT`, then complete one native Grok Bot tool and delivery turn.
7. Inspect `~/sand-data/grok-codex-router.log` for route, transport, continuation, and usage records. Never add body or credential logging.
