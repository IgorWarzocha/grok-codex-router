#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

for command in node bun git; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    printf 'ERROR: required command is missing: %s\n' "${command}" >&2
    exit 1
  fi
done

printf '%s\n' 'Installing locked dependencies...'
bun install --frozen-lockfile --ignore-scripts

printf '%s\n' 'Preparing preserved router state...'
bun run build
node dist/bin/grok-codex-router.js service-stop

printf '%s\n' 'Building and checking the router...'
bun run check

printf '%s\n' 'Linking the management command...'
bun link --ignore-scripts

printf '%s\n' 'Installing the host patch and control service...'
node dist/bin/grok-codex-router.js install

printf '%s\n' 'Verifying the direct cached tool round-trip...'
node dist/bin/grok-codex-router.js verify

printf '\n%s\n' 'Grok Codex Router is ready.'
printf '%s\n' 'Control UI: http://127.0.0.1:21371'
node dist/bin/grok-codex-router.js status
