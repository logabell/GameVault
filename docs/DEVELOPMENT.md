# Development Setup

This page covers development commands and quality checks. For end-user setup, see [Installation](INSTALLATION.md).

## Prerequisites

- Node 22.x.
- Chrome, Edge, or Firefox for extension testing.

## Repository Layout

```text
apps/
  desktop/        Electron tray app, native bridge, SQLite database, services, renderer UI
  extension/      Browser extension background/content/popup scripts and manifest
packages/
  shared-types/   Shared models, native-message contracts, status helpers, library controls
  source-core/    Source parsers, catalog discovery, source matching helpers
  steam-core/     Steam search, covers, SteamDB RSS/build parsing, watch helpers
scripts/          Repo-level maintenance scripts
docs/             Project documentation
```

## Common Commands

```powershell
npm install
npm run build          # Build all workspaces
npm run dev:desktop    # Build and run the Electron desktop app
npm run dev:extension  # Watch/rebuild the browser extension
npm run lint           # ESLint
npm run typecheck      # TypeScript project references
npm test               # Vitest
npm run check:unused   # Knip unused-code/dependency check
npm run clean          # Remove generated build/cache output
```

## Extension Dev Loop

```powershell
npm run dev:extension
```

- This keeps rebuilding `apps\extension\dist` on file changes.
- In the browser, click `Reload` on the GameVault extension after code changes.
- Reopen the popup after reload.
- For content-script changes, refresh the supported page too.

## Native Messaging During Development

Register Chrome/Edge native messaging after loading the unpacked extension:

```powershell
node .\apps\desktop\scripts\register-native-host.mjs --extension-id=YOUR_EXTENSION_ID --browser=both
```

Register Firefox native messaging:

```powershell
node .\apps\desktop\scripts\register-native-host.mjs --browser=firefox
```

Remove native messaging:

```powershell
node .\apps\desktop\scripts\unregister-native-host.mjs
```

## Quality Gate

Run this before a production-facing push:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run check:unused
npm audit --omit=dev
```

## Cleanup Guidance

- Keep source parsers and native-message contracts conservative; they are shared by the desktop app and extension.
- Add focused tests when changing database behavior, source parsing, download/provider selection, native messaging, or update status logic.
- Prefer compatibility-preserving migrations. Do not remove old migrations or legacy database-opening paths unless there is a deliberate migration plan.
- Treat unused-code tooling as a signal to triage, not as automatic permission to delete source entrypoints.
