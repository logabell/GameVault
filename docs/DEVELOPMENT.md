# GameVault Development Setup

## Prerequisites

- Node 22.x
- Chrome, Edge, or Firefox

## Build

```powershell
npm install
npm run build
```

## Run the desktop tray app

```powershell
npm run dev:desktop
```

## Load the extension in Chrome or Edge

1. Open `chrome://extensions` or `edge://extensions`
2. Enable developer mode
3. Load unpacked from `C:\projects\GameVault\apps\extension\dist`
4. Copy the extension id shown in the browser
5. After the first load, keep using the same unpacked extension. You do not need to reinstall it for normal code changes.

## Load the extension in Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click `Load Temporary Add-on`
3. Select `C:\projects\GameVault\apps\extension\dist\manifest.json`
4. Confirm the add-on ID is `gamevault@vaulttrack.local`

## Extension dev loop

```powershell
npm run dev:extension
```

- This keeps rebuilding `apps/extension/dist` on file changes.
- In the browser, click `Reload` on the GameVault extension after code changes.
- Reopen the popup after reload. For content-script changes, refresh the supported page too.

## Register native messaging

```powershell
node .\apps\desktop\scripts\register-native-host.mjs --extension-id=YOUR_EXTENSION_ID --browser=both
node .\apps\desktop\scripts\register-native-host.mjs --browser=firefox
```

## Remove native messaging

```powershell
node .\apps\desktop\scripts\unregister-native-host.mjs
```
