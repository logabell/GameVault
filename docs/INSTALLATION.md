# Installation

GameVault is now distributed as a Windows installer from GitHub Releases. Source builds are still supported for development, but normal installs should use the release installer.

## Requirements

- Windows.
- Chrome, Edge, or Firefox for the browser extension.
- Optional: JDownloader 2 and a MyJDownloader account.
- Optional: Real-Debrid or another JDownloader-supported premium/multi-host account configured inside JDownloader.

Node.js and npm are only needed if you are building GameVault from source.

Firefox support expects Firefox `128.0` or newer. The extension manifest uses the Firefox add-on ID `gamevault@vaulttrack.local`.

## Install The Latest Release

1. Open the [GameVault Releases page](https://github.com/logabell/GameVault/releases/latest).
2. Download the Windows installer named `GameVault-Setup-<version>.exe`.
3. Run the installer.
4. Launch GameVault from the Start Menu or desktop shortcut.
5. Choose a root library folder during setup or from Settings.

The first public/private release is `1.0.0`, so its installer is named `GameVault-Setup-1.0.0.exe`.

GameVault's current Windows installer is not code-signed. Windows SmartScreen may ask for confirmation before running it.

## Browser Extension Setup

GameVault ships the browser extension inside the desktop install. The desktop app shows the exact extension folder or manifest path to use during setup.

### Chrome Or Edge

1. Open GameVault.
2. In the setup wizard or Settings, open the browser extension setup instructions.
3. Open `chrome://extensions` or `edge://extensions`.
4. Enable Developer Mode.
5. Choose "Load unpacked".
6. Select the extension folder shown by GameVault.
7. Copy the extension ID shown by the browser.
8. Paste that extension ID into GameVault.
9. Select "Register Chrome/Edge" in GameVault to register native messaging.

### Firefox

1. Open GameVault.
2. In the setup wizard or Settings, switch the browser extension instructions to Firefox.
3. Open `about:debugging#/runtime/this-firefox`.
4. Choose "Load Temporary Add-on".
5. Select the `manifest.json` file shown by GameVault.
6. Select "Register Firefox" in GameVault to register native messaging.

Firefox temporary add-ons must be loaded again after restarting Firefox.

## Optional JDownloader Setup

GameVault integrates with MyJDownloader, not directly with Real-Debrid.

1. Install and run [JDownloader 2](https://jdownloader.org/jdownloader2).
2. Sign in to MyJDownloader inside JDownloader.
3. If you use Real-Debrid, add your Real-Debrid account inside JDownloader's Account Manager.
4. In GameVault Settings, connect MyJDownloader with your MyJDownloader email/password.
5. Select the online JDownloader device that should receive queued packages.
6. Enable the JDownloader source preferences you want GameVault to use.

Real-Debrid credentials are never stored by GameVault. JDownloader owns host accounts, LinkGrabber, captchas, premium/multi-host behavior, and extraction.

## First-Run Checklist

1. Install and launch GameVault.
2. Choose a root library folder.
3. Load the bundled browser extension.
4. Register native messaging from GameVault setup or Settings.
5. Open the extension popup and confirm the desktop bridge is healthy.
6. Optional: connect MyJDownloader and choose a device.
7. Optional: tune source watch duration, source watch interval, daily SteamDB hour, theme, and source-specific JDownloader preferences.

## Build From Source

Use this path for development or local testing.

```powershell
git clone https://github.com/logabell/GameVault.git
cd GameVault
npm install
npm run build
npm run dev:desktop
```

To build a local Windows installer:

```powershell
npm run package:windows
```

The installer output is written under `apps\desktop\release`.

## Data Locations

- Main database: `gamevault.sqlite` in Electron's user-data directory.
- Legacy database migration: GameVault can migrate from the old `vaulttrack.sqlite` path.
- Library files: stored under the root library path selected in Settings.
- Staging files: stored under `<root library>\_STAGING`.
- Native host files: stored under `%LOCALAPPDATA%\GameVault\NativeHost`.
- MyJDownloader credentials: stored in the local database after encryption through Electron `safeStorage`.
- Real-Debrid credentials: never stored by GameVault; configure them in JDownloader only.
