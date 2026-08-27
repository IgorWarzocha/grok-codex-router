1. Start with grok-codex-router status. Do not infer account validity from one preferred filename.
2. Check the candidate store with its owning client and a minimal provider request without printing token fields, account identifiers, or authorization headers.
3. Switch only to an already authenticated store with grok-codex-router auth-store pi or grok-codex-router auth-store codex.
4. Keep one credential owner. Do not copy refresh tokens into another file or add a login flow to this repository.
5. If both stores are missing, expired, or rejected, stop and ask the user to authenticate one client. Resume only after the user confirms login completed.
