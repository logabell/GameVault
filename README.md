# GameVault

GameVault is a desktop app and browser extension for tracking a PC game library against supported source pages and SteamDB patch metadata. It helps you understand what is installed, what source release it came from, whether a newer release is available, and what action is needed next.

## What It Does

- Tracks installed games, source versions, Steam matches, SteamDB patches, and local file state.
- Adds games directly from supported browser source pages.
- Matches games to Steam apps and SteamDB patch/build history.
- Compares supported sources when a game may be available from more than one place.
- Watches tracked sources and SteamDB metadata for possible updates.
- Queues downloads through the safest available path for the selected source.
- Supports direct desktop downloads, MyJDownloader handoff, and manual staged install flows.
- Imports existing library folders into GameVault tracking.
- Surfaces failed downloads, stale checks, rate limits, and source issues through an Activity view.

## Supported Sources

GameVault currently supports specific detail-page formats from:

- AnkerGames
- ElAmigos
- SteamRIP

## JDownloader And Real-Debrid

GameVault integrates with MyJDownloader, not directly with Real-Debrid.

The intended workflow is that JDownloader owns host accounts, Real-Debrid, LinkGrabber, captchas, and extraction. GameVault stores only MyJDownloader connection details, then sends selected source links and package paths to the chosen JDownloader device when that provider is enabled and healthy.

Real-Debrid credentials are never requested or stored by GameVault. Configure Real-Debrid inside JDownloader if you use it.

## Local-First Design

GameVault stores its operational data locally. Library files remain under the root library folder you choose, and active work is staged under that library root. MyJDownloader credentials are encrypted locally through Electron `safeStorage`; Real-Debrid credentials stay in JDownloader.

## Documentation

- [Installation](docs/INSTALLATION.md)
- [User Guide](docs/USER_GUIDE.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Development Setup](docs/DEVELOPMENT.md)

## Intended Use

GameVault is a personal library and update-tracking tool. Use it only with games and download sources you are legally allowed to access, preserve, or install. GameVault does not host files, provide source-site credentials, bypass DRM, crack software, or grant rights to third-party content.

Real-Debrid, JDownloader, source sites, SteamDB, Steam, and browser vendors each have their own terms and behavior. GameVault coordinates local metadata and automation around those tools; it does not replace their rules or accounts.
