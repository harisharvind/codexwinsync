# codexwinsync

Enable **Settings > Connections > Control other devices** in Codex Desktop for Windows without modifying `ChatGPT.exe`, `app.asar`, or any file under `C:\\\\\\\\\\\\\\\\Program Files\\\\\\\\\\\\\\\\WindowsApps`.

Tested with Codex Desktop `26.715.7063.0` and `26.715.10079.0` on Windows 11.

> \\\\\\\\\\\\\\\[!IMPORTANT]
> Enable multi-factor authentication (MFA) on your OpenAI/ChatGPT account \\\\\\\\\\\\\\\*\\\\\\\\\\\\\\\*before\\\\\\\\\\\\\\\*\\\\\\\\\\\\\\\* linking the account or adding a device. Remote-control enrollment requires MFA to already be active.

> \\\\\\\\\\\\\\\[!WARNING]
> This is an unofficial, version-sensitive runtime experiment. It launches Codex with localhost debugging ports that can execute code inside the Codex process. Use it only on a trusted machine, and launch Codex normally when you are finished.

## What works

* Shows the shipped **Control other devices** tab on Windows.
* Authorizes and stores a Windows controller device key.
* Lists signed-in Codex devices available to control.
* Opens projects on a connected remote host.
* Imports preexisting projects from connected hosts into the Windows sidebar.
* Leaves the installed Codex package unchanged.

!\[Control other devices in Settings](https://gist.github.com/hunterbeach/dc4b74bda0e045e33f308099182b4f80/raw/cc7746ab3e0e4110788a3b5f91fda7ad4da16322/Connections%2520Page.png)

!\[Creating a project on a connected host](https://gist.github.com/hunterbeach/dc4b74bda0e045e33f308099182b4f80/raw/cc7746ab3e0e4110788a3b5f91fda7ad4da16322/New%2520Codex%2520Project%2520Page.png)

## Requirements

* Windows 10 or Windows 11.
* Codex Desktop installed from the Microsoft Store/MSIX package.
* Node.js 22 or newer available as `node.exe` on `PATH`.
* MFA enabled on the OpenAI/ChatGPT account before device enrollment.
* Another signed-in Codex host available on the same account.

## Run

1. Clone the repository:

```powershell
   git clone https://github.com/<your-github-username>/codexwinsync.git
   cd codexwinsync
   ```

2. Quit Codex Desktop.
3. Run the launcher:

```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\\\\\\\\\\\\\\\\launch-codex-remote-control.ps1
   ```

4. In Codex, open **Settings > Connections > Control other devices**.
5. Select **Add** and complete authorization with the MFA-enabled account.
6. Create a project and choose the connected device under **New remote project**.

The launcher writes diagnostics to `%TEMP%\\\\\\\\\\\\\\\\codexwinsync.log`.

Preexisting projects normally appear within 30 seconds after their host connects. The importer reads only project names and root paths from that host's Codex global state, adds missing entries to the Windows controller's project index, and never copies or deletes project files.

## How it works

Codex Desktop `26.715` ships the Windows remote-controller UI and backend client, but two checks prevent the controller flow from working:

1. Statsig gate `782640499` is inverted in the renderer. A value of `true` hides `showControlOtherDevices`, so the runtime override forces this one gate to `false`.
2. The main process rejects device-key operations unless `process.platform` is `darwin`, then tries to load `remote-control-device-key.node`, which is not shipped in the Windows package.

The launcher starts Codex with renderer DevTools on `127.0.0.1:9322` and the Electron main-process inspector on `127.0.0.1:9333`. It then:

* Overrides only Statsig gate `782640499` in renderer Statsig clients.
* Reports `darwin` only while the shipped `getAddon()` device-key method is on the call stack.
* Intercepts only requests for `remote-control-device-key.node`.
* Supplies an in-memory P-256 signing implementation.
* Encrypts private keys with Windows DPAPI using `CurrentUser` scope.
* Stores encrypted keys in `\\\\\\\\\\\\\\\~\\\\\\\\\\\\\\\\.codex\\\\\\\\\\\\\\\\remote-control-device-keys.windows.json`.

## Disable or remove

To disable the runtime hooks, quit Codex and launch it normally. The hooks and debugging ports exist only in the specially launched process.

After revoking remote-control access in Codex, you can optionally remove the encrypted Windows key store:

```powershell
Remove-Item -LiteralPath "$HOME\\\\\\\\\\\\\\\\.codex\\\\\\\\\\\\\\\\remote-control-device-keys.windows.json"
```

You can then delete this gist folder. No installed Codex files need restoration.

## Troubleshooting

* **The tab is missing:** Confirm Codex was launched by `launch-codex-remote-control.ps1`, then inspect `%TEMP%\\\\\\\\\\\\\\\\codexwinsync.log`.
* **Authorization fails before linking:** Confirm MFA was enabled before starting device enrollment, then retry **Add**.
* **No devices appear:** Confirm the other Codex host is signed in to the same account, online, and configured to allow remote control.
* **Existing remote projects are missing:** Keep the host connected for up to 30 seconds. Confirm the runtime log contains `Codex remote-project metadata sync is active.` and relaunch with the script if it does not.
* **A Codex update breaks the launcher:** Launch Codex normally and stop using the override until the relevant gate and device-key code are reviewed for the new build.

## Credits

\- \*\*\[Hunter Beach](https://github.com/hunterbeach)\*\* —  fixed the sync part and documented the workaround.

\- \*\*\[h5kk](https://github.com/h5kk)\*\* — discovered and verified that patching the feature flag enables the complete OAuth and device-pairing flow.

\- \*\*\[russlib](https://github.com/russlib)\*\* — identified feature gate `782640499` and documented how the Windows bundle hides the controller tab.

\- Everyone contributing research, testing, and reports to \[OpenAI Codex issue #28919](https://github.com/openai/codex/issues/28919).

\- OpenAI for Codex and the underlying remote-connections functionality.



This project is an independent, community-maintained workaround and is not affiliated with or endorsed by OpenAI.

