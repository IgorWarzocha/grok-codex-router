---
name: grok-codex-router
description: "Read before installing, recovering, routing, or diagnosing this repository's Codex inference integration for Grok Bot."
---

1. Discover and load applicable OAuth inference, prompt-caching, dependency, and review skills before changing transport or the host patch.
2. Work from this checkout. Treat src/, control/, scripts/, bin/, and ui/ as canonical. Never edit dist/ or host-main.cjs by hand.
3. Run grok-codex-router status before acting. Use the control UI at http://127.0.0.1:21371 for ordinary routing, usage, logs, and recovery.
4. Reuse the configured Pi or Codex OAuth store. Never start login unless status and a real provider request prove every existing store invalid. Read [OAuth ownership](references/oauth-ownership.md) before switching.
5. Let the control service recover compatible Sand updates. If recovery reports incompatible, stop automatic mutation and read [Unknown Sand host](references/unknown-sand-host.md).
6. After transport, patch, or recovery changes, run bun run check first. It checks router-owned behavior and the live VM without contacting OpenAI. Then run grok-codex-router patch-host --check, grok-codex-router verify, and one native Grok Bot tool and delivery turn.
7. Never log or publish credentials, prompts, message bodies, tool arguments, authorization headers, OAuth callback material, or the proprietary Sand host bundle.
