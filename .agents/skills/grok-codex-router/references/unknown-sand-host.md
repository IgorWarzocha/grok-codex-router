1. Run grok-codex-router diagnose > /tmp/grok-codex-router-report.md. Inspect the report before publishing it.
2. Never attach host-main.cjs, OAuth files, router request logs, prompts, tool arguments, or credentials.
3. Trace the new bundle from agent selection through turn composition and inference-session construction. Confirm immutable agent identity and every workload flag at the inference boundary.
4. Change scripts/patch-host.ts, not the live bundle. Require one unique anchor, marker idempotence, a pristine backup, and failure on unknown shapes.
5. Reproduce against a local host fixture or disposable copy. Run npm run check, grok-codex-router patch-host --check, direct verification, and a native Grok Bot turn before considering recovery complete.
6. Follow the active harness rules before creating a fork, pushing a branch, or filing an issue. Report confirmed compatibility work at https://github.com/IgorWarzocha/grok-codex-router/issues/new with the sanitized report and a link to the tested fork or commit.
7. State whether the live VM was repaired. An issue or successful dry run is not proof that the running host loaded the patch.
