# Multi-Hoster-Upload

Multi-Hoster-Upload is a Windows desktop app for managing large file batches across multiple video hosting services from one queue.

![Multi-Hoster-Upload product overview](assets/product-overview.png)

[Download the latest release](https://github.com/Sucukdeluxe/Multi-Hoster-Upload/releases/latest)

## Capabilities

- Upload one batch to several supported hosters in parallel.
- Manage multiple accounts per hoster with validation, health checks, automatic rotation, and inline OTP completion.
- Filter uploads, accounts, and history from task-focused sidebars without changing the underlying queue.
- Add files by drag and drop or file selection and monitor live queue progress.
- Use the complete interface in English or German and switch languages without restarting the app.
- Control per-hoster concurrency, bandwidth limits, retries, folder monitoring, notifications, and completed-item cleanup.
- Keep local upload history, choose a retention period, and copy completed links in bulk.
- Transfer accounts and settings with a 75-character encrypted online key while encryption and decryption stay on the client.
- Check for updates from Settings or Help; when a newer release is available, install it from the header update action and accessible update dialog.

## Supported hosters

| Hoster | Authentication |
| --- | --- |
| Doodstream | Web login or API key |
| VOE | Web login or API key |
| Vidmoly | Web login |
| Byse | API key |
| Clouddrop | API key |

## Installation

1. Download the Setup or portable executable from the [latest GitHub release](https://github.com/Sucukdeluxe/Multi-Hoster-Upload/releases/latest).
2. Run the installer, or launch the portable executable directly.
3. Add and validate at least one hoster account in Accounts, then select files and start the queue.

## Local data and credentials

Settings, queue state, and upload history are stored locally in the app's user-data directory. Hoster passwords and API keys are encrypted with Electron safeStorage before being written when operating-system encryption is available; on Windows this uses DPAPI for the current user profile. Online backups are optional, contain accounts and settings only, and are encrypted on the client before the server receives them. Upload history and queue state remain on the original device.

## Development

```powershell
npm install
npm start
npm test
npm run lint
npm run release:win
```
