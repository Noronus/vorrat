# Vorrat

Self-hosted pantry inventory for your household: scan a barcode, record how much is left and when it expires, get reminded in time, and let Claude suggest meals from what you already have.

"Vorrat" is German for pantry stock. **The app's interface is currently German only.** If you would like an English version, [open an issue](https://github.com/Noronus/vorrat/issues) and I will gladly add one.

<p>
  <img src="docs/vorrat.png" width="200" alt="Inventory list with fill level and expiry date">
  <img src="docs/eintrag.png" width="200" alt="Editing an item: packages, fill level, best-before date">
  <img src="docs/kochen.png" width="200" alt="Six recipe suggestions as tiles">
  <img src="docs/rezept.png" width="200" alt="Recipe with ingredients and steps">
</p>

![Desktop view of the inventory](docs/desktop.png)

## Features

- **Inventory:** barcode scanning with the phone camera (decoded on the device), product data from [Open Food Facts](https://world.openfoodfacts.org), fill level per package, number of packages, expiry date
- **Reminders:** a daily notification when something is about to expire (web push, or local notifications in the Android app)
- **Cooking with Claude:** six suggestions based on your inventory, optionally after a few tap-to-answer questions or from a photo of ingredients; weekly meal plan; deduct the ingredients from the inventory after cooking
- **Recipes and shopping list:** save suggestions, add your own recipes, put missing ingredients on the shopping list
- **Multiple users:** invite-only accounts, two-factor login (TOTP), no automatic logout, changes show up on all devices immediately
- **Runs everywhere:** installable web app (Android, iOS, desktop) and a small Android app with a native scanner

## Structure

| Folder | Contents |
| --- | --- |
| `server/` | Node 24, Fastify, SQLite (`node:sqlite`). TypeScript runs directly, without a build step. |
| `web/` | React and Vite, served by the server as a PWA |
| `android/` | Android app (WebView with a native barcode scanner and local reminders) |

All data lives in a single SQLite file (`vorrat.db`) in the data directory.

## Installation

### Docker Compose

```bash
curl -O https://raw.githubusercontent.com/Noronus/vorrat/main/docker-compose.yml
mkdir data
docker compose up -d
```

Then open `http://SERVER-IP:8095/`. The first account you create becomes the admin. The admin invites further people by link under "Mehr" (More).

### Unraid

Copy `unraid-template.xml` to `/boot/config/plugins/dockerMan/templates-user/my-Vorrat.xml` and create the container from that template under Docker → "Add Container".

### Build it yourself

```bash
docker build -t vorrat .
docker run -d --name vorrat -p 8095:8080 -v "$PWD/data:/data" --user 1000:1000 vorrat
```

`deploy.sh` builds the image locally and loads it onto a Docker host over SSH. The connection details go in `deploy.env` (template: `deploy.env.example`).

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `TZ` | `Europe/Berlin` | Time zone for expiry dates and the reminder time |
| `PORT` | `8080` | Port inside the container |
| `DATA_DIR` | `/data` | Database and working directory of the Claude CLI |
| `TRUST_PROXY` | on | Honours `X-Forwarded-*` from a reverse proxy. Set to `false` if the container faces the internet without a proxy. |
| `VAPID_SUBJECT` | `mailto:vorrat@example.com` | Contact address for web push |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | empty | Alternative to entering the token in the app |

## Connecting Claude

The server calls the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) in headless mode. It is included in the image and runs without tools: Claude receives the inventory as text and returns a result validated against a JSON schema.

1. On a machine with Claude Code, run `claude setup-token` (uses your own Claude subscription), or create an API key.
2. In the app, as admin, enter it under "Mehr" → "Claude und Erinnerungen".

The token is then stored in the database and never displayed again. All accounts in the household share its quota. Without a token, everything except the suggestions works.

## Android app

The prebuilt APK is available under [Releases](https://github.com/Noronus/vorrat/releases). To build it yourself:

```bash
cd android
./gradlew assembleRelease
```

Requirements: JDK 21 (path in `gradle.properties`) and the Android SDK (`local.properties` with `sdk.dir=…`). For signing, create a `keystore.properties` with `storeFile` and `password`; the key alias is `vorrat`. On first launch the app asks for your server's address.

The app does not need Google services: it asks the server about once an hour for expiring items and shows the reminder locally.

## Security

Built to be reachable from the internet, though a reverse proxy with HTTPS in front is still recommended:

- Passwords hashed with scrypt; session cookie is `HttpOnly` and `SameSite=Lax` (plus `Secure` over HTTPS)
- TOTP with replay protection, recovery codes, lockout after failed attempts
- Registration by invitation only
- Origin check against CSRF, strict Content Security Policy, rate limits
- The container runs without root and without capabilities

If a proxy with its own login sits in front (for example NetBird with a PIN), the app recognises the proxy's login page by the missing `X-Vorrat` response header and reloads instead of showing errors.

Please do not report vulnerabilities as public issues. Use "Security" → "Report a vulnerability" in the repository.

## Development

```bash
cd web && npm ci && npm run build          # or: npm run dev
cd ../server && npm ci
DATA_DIR=./data WEB_ROOT=../web/dist PORT=8080 node src/index.ts
```

The Claude features need `claude` installed and logged in locally.

## Backup

Stop the container and copy the data directory, or back up while it is running with SQLite:

```bash
sqlite3 data/vorrat.db "VACUUM INTO 'backup.db'"
```

## License

[MIT](LICENSE)
