# DeepSeek Usage Monitor

- TypeScript VS Code extension. Extension source is in `src/`; npm lockfile is authoritative.
- Useful checks: `npm run compile`, `npm run selfcheck`; packaging uses `npm run package` and should only be run when requested.
- Preserve VS Code extension activation/contribution conventions and existing API-key handling; never log or expose credentials.
