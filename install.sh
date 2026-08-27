#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

for command in node npm bun git; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    printf 'ERROR: required command is missing: %s\n' "${command}" >&2
    exit 1
  fi
done

printf '%s\n' 'Installing locked dependencies...'
npm ci --ignore-scripts

printf '%s\n' 'Building and checking the router...'
npm run check

printf '%s\n' 'Linking the management command...'
npm link --ignore-scripts

printf '%s\n' 'Installing the host patch and control service...'
grok-codex-router install

printf '%s\n' 'Verifying the direct cached tool round-trip...'
grok-codex-router verify

printf '\n%s\n' 'Grok Codex Router is ready.'
printf '%s\n' 'Control UI: http://127.0.0.1:3210'
grok-codex-router status
