# GameVault

![GameVault library dashboard demo](docs/assets/gamevault-demo.gif)

GameVault is a local-first Windows desktop app and browser extension for tracking PC game libraries, supported source releases, SteamDB patch history, Steam Wishlist items, and Playnite library metadata from one dashboard.

## What It Does

- Tracks installed games, discovered source pages, source versions, Steam matches, SteamDB patches, update status, and local file state.
- Adds games from supported source pages through the browser extension.
- Syncs Steam Wishlist items
- Integrates with Playnite through a bundled plugin for GameVault library sync, executable tracking, and IGDB metadata backfill.
- Compares supported sources and watches tracked source/SteamDB metadata for updates.
- Queues installs through direct desktop downloads, MyJDownloader handoff, or manual staged install flows.
- Imports existing library folders and reports failed downloads, stale checks, rate limits, and source issues

## Supported Sources

- AnkerGames
- ElAmigos
- SteamRIP

## Integrations

- Steam and SteamDB for app matching, patch/build history, cover art, and wishlist sync.
- Playnite for library sync, launch executable tracking, and metadata handoff.
- MyJDownloader for optional remote download queueing. Real-Debrid can be configured inside JDownloader; GameVault does not store Real-Debrid credentials.

## License

GameVault is licensed under the GNU General Public License v3.0. Use it only with games and sources you are legally allowed to access. GameVault does not host files, provide source-site credentials, bypass DRM, or grant rights to third-party content.
