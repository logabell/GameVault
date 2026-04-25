# User Guide

This guide covers the normal GameVault workflow after the desktop app and browser extension are installed.

## Add A New Game

1. Open a supported source detail page in the browser.
2. Open the GameVault extension popup.
3. Review the parsed source data and download mirrors.
4. Choose or confirm the Steam match.
5. Select the SteamDB patch/build that represents the source release, or enter a manual patch/version when needed.
6. Choose the source and mirror to use.
7. Queue the download, save the tracked game, or create a draft depending on the current page state.

## Manage The Library

Use the Library view to:

- Search, sort, and filter tracked games.
- Switch card/list views.
- Inspect installed version, source version, Steam patch/build, file state, and source health.
- Retry downloads, cancel downloads, mark a download failed, or clear a failed mirror.
- Queue an update from the current or alternate source.
- Complete staged installs after extraction or manual installer work is done.
- Remove only GameVault tracking or remove tracking plus known local files.

## Import Existing Games

1. Set a root library folder in Settings.
2. Open Import.
3. Scan folders under the root library path.
4. Ignore folders that should not be tracked.
5. Match each folder to a Steam app and, when available, a supported source.
6. Select or manually enter the installed patch/build/version.
7. Save the import batch.

Imported games use `manual` source records until they are matched to a supported source. GameVault can later discover supported source matches and apply them.

## Track Updates

GameVault tracks updates from two angles:

- Source pages: supported source pages can be refreshed and watched for newer source releases.
- SteamDB: matched Steam apps can sync patch history from SteamDB RSS and, when needed, use build-table rows captured from SteamDB patchnotes pages.

Activity cards call out stale checks, source errors, SteamDB rate limits, failed downloads, and scheduler catch-up work.

## Complete Downloads And Installs

GameVault records download state as queued, downloading, extracting, staged, failed, or complete.

- Direct desktop downloads can finish automatically when GameVault can resolve, download, extract, and move the game folder safely.
- JDownloader downloads depend on the selected MyJDownloader device and the package state reported by JDownloader.
- Manual downloads create a staged job. Download or extract the files yourself, then use the GameVault action to confirm readiness or complete the staged install.
- ElAmigos full replacement installers require confirmation before completing installation.
- SteamRIP manual installs expect the extracted game folder to appear in the staged workspace before completion.

## Settings

Common settings include:

- Root library path.
- Theme mode.
- MyJDownloader connection and selected device.
- Source-specific JDownloader preferences.
- Source watch duration and interval.
- Daily SteamDB maintenance hour.
- Import folder ignore list.
- Rename folders on import.
