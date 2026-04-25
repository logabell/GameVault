# Troubleshooting

## Extension Says The Desktop Bridge Is Unavailable

- Make sure the desktop app is running.
- Reload the unpacked extension after a rebuild.
- Re-register native messaging if the extension ID changed.
- Confirm the native host name is `com.gamevault.desktop`.
- Wait a few seconds after desktop startup; the bridge starts locally on `127.0.0.1:47615`.

## Chrome Or Edge Cannot Use Native Messaging

- Confirm you passed the exact unpacked extension ID to `register-native-host.mjs`.
- Re-run registration after reloading a new unpacked extension with a new ID.
- Use `--browser=both` for Chrome and Edge.

## Firefox Cannot Use Native Messaging

- Confirm the loaded add-on ID is `gamevault@vaulttrack.local`.
- Run `register-native-host.mjs --browser=firefox`.
- Firefox temporary add-ons must be reloaded after browser restarts.

## MyJDownloader Is Not Ready

- Start JDownloader.
- Confirm JDownloader is signed in to MyJDownloader.
- Reconnect MyJDownloader in GameVault Settings.
- Select an online device in GameVault Settings.
- Check JDownloader LinkGrabber for captcha, offline links, or account errors.

## Real-Debrid Is Not Being Used By JDownloader

- Confirm the Real-Debrid account is added and enabled in JDownloader Account Manager.
- Check JDownloader account usage rules if another account or free mode is being selected first.
- Confirm the host is currently supported by Real-Debrid and available in JDownloader.
- Fix account/host issues in JDownloader; GameVault only queues selected links to MyJDownloader.

## SteamDB Checks Fail Or Pause

- SteamDB may rate limit requests or challenge browser access.
- GameVault records rate-limit backoff in Activity and retries later.
- Use manual patch/build entry when SteamDB metadata is unavailable.
- Visit the SteamDB patchnotes page in the browser when the extension needs to capture build-table rows.

## A Supported Page Is Not Detected

- Confirm the URL matches one of the supported detail-page patterns.
- Refresh the page after reloading the extension.
- Site markup changes may require parser updates in `packages/source-core`.

## Download Gets Stuck In Manual Or Staged State

- Check the selected source and mirror.
- For JDownloader jobs, inspect the package in JDownloader LinkGrabber or Downloads.
- For manual SteamRIP jobs, extract the game folder into the staged workspace before completing the install.
- For ElAmigos full installers, confirm download readiness first, run the installer into the expected library folder, then complete the install in GameVault.
- Use Activity to retry source refreshes, poll downloads, or dismiss resolved issues.
