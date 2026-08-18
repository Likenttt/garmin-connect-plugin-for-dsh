# dsh-plugin-garmin-connect

> A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin that brings your Garmin fitness & health data into the AI agent loop.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

---

## More Apps

| Icon | App | What it does |
|---|---|---|
| [<img src="https://gamerasnap.com/static/images/appicon.png" width="32" height="32" alt="GameraSnap" />](https://gamerasnap.com) | [GameraSnap](https://gamerasnap.com) | Control your phone camera from your Garmin watch |
| [<img src="https://wristalbum.wristtale.com/app-icon.svg" width="32" height="32" alt="WristAlbum" />](https://wristalbum.wristtale.com) | [WristAlbum](https://wristalbum.wristtale.com) | Keep a private photo album on your Garmin |
| [<img src="https://wristtale.com/static/favicons/apple-touch-icon.png" width="32" height="32" alt="WristTale" />](https://wristtale.com) | [WristTale](https://wristtale.com) | Read TXT and Markdown on your Garmin watch |
| [<img src="https://wristpass.li2niu.com/static/favicons/apple-touch-icon.png" width="32" height="32" alt="WristPass" />](https://wristpass.li2niu.com) | [WristPass](https://wristpass.li2niu.com) | Keep cards and tickets ready on your wrist |
| [<img src="https://2fa4g.li2niu.com/static/branding/app-icon.png" width="32" height="32" alt="2FA4G" />](https://2fa4g.li2niu.com) | [2FA4G](https://2fa4g.li2niu.com) | Keep offline 2FA codes on your Garmin |
| [<img src="https://jiake.app/app-icon.png" width="32" height="32" alt="JiaKe.app" />](https://jiake.app) | [JiaKe.app](https://jiake.app) | Turn Garmin screenshots into polished assets |

---

## What It Does

This plugin connects [DeepSeek Harness](https://github.com/deepseek-ai/dsh) to [Garmin Connect](https://connect.garmin.com/), exposing your wearable data as **AI-callable tools**. Once installed, the DeepSeek agent can automatically query your activities, sleep, steps, and heart rate to provide personalized fitness insights — all through natural language.

### Registered Tools

| Tool | Description | Example Args |
|---|---|---|
| `get_garmin_activities` | Fetch recent activities (runs, rides, swims…) with pace, HR, calories | |
| `get_garmin_sleep` | Sleep score, duration, and stage breakdown (deep / light / REM) | |
| `get_garmin_steps` | Daily step count, goal progress, and walking distance | |
| `get_garmin_heart_rate` | Resting, max, and min heart rate for a given day | `{"startDate": "2023-10-01", "endDate": "2023-10-02"}` |
| `get_garmin_weight` | Body composition (weight, BMI, body fat %, muscle mass, etc.) | `{"startDate": "2023-10-01"}` |
| `get_garmin_workouts` | Planned workouts from your Garmin calendar | `{"limit": 10, "offset": 0}` |
| `get_garmin_profile` | User profile summary | `null` |
| `export_garmin_session` | Export a session token for password-free future logins | `null` |

---

## Quick Start

### 1. Install this plugin — from the npm registry (recommended)

```bash
npx --legacy-peer-deps=false @deepseek-ai/dsh plugin --profile web add dsh-plugin-garmin-connect
```

This single command installs the dependency **and** activates the plugin layer — the first run automatically initializes the `web` profile. You only need `pnpm` on your `PATH`:

```bash
npm install -g pnpm
```

> `--legacy-peer-deps=false` makes npm resolve peer dependencies normally. If your npm config has `legacy-peer-deps=true` (it skips peer packages), dsh would fail to boot with `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis-plugin-group'`. On machines without that setting the flag is a harmless no-op.

Verify the plugin layer is composed without booting:

```bash
npx --legacy-peer-deps=false @deepseek-ai/dsh --profile web --dump-config | grep -A 2 garmin-connect
```

Other install sources:

```bash
# Local checkout (development)
cd dsh-plugin-garmin-connect && npm install
npx --legacy-peer-deps=false @deepseek-ai/dsh plugin --profile web add .

# GitHub source install
npx --legacy-peer-deps=false @deepseek-ai/dsh plugin --profile web add github:<owner>/<repo>
```

### 2. Install the Harness CLI (if you haven't already)

```bash
npx --legacy-peer-deps=false @deepseek-ai/dsh web
```

The web UI starts at `http://127.0.0.1:3080` by default. If you launch Harness via `npx`, keep using the same prefix for the commands below (`npx --legacy-peer-deps=false @deepseek-ai/dsh …`); if you have `dsh` installed globally, you can drop the `npx @deepseek-ai/` prefix.

### 3. Configure Credentials

This plugin **never** stores passwords in config files or logs. Credentials are resolved through environment variables.

```bash
# Copy the template
cp .env.example .env

# Edit .env and fill in your Garmin credentials
```

Put the `.env` file in the directory you run `dsh` from (your workspace root) — the plugin loads it automatically.

| Variable | Required | Description |
|---|---|---|
| `GARMIN_USERNAME` | ✅ | Your Garmin account email |
| `GARMIN_PASSWORD` | ✅* | Account password |
| `GARMIN_SESSION_TOKEN` | ✅* | Pre-authenticated token (alternative to password) |
| `GARMIN_REGION` | ❌ | `global` (default) or `cn` for Garmin China |
| `GARMIN_CACHE_TTL` | ❌ | Cache duration in seconds (default: `300`) |
| `GARMIN_LOG_LEVEL` | ❌ | `debug` \| `info` \| `warn` \| `error` |
| `GARMIN_ACTIVITY_DETAIL` | ❌ | Default detail for `get_garmin_activities`: `compact` (default, curated fields, saves context) or `full` (all raw Garmin fields) |

> \* You need **either** `GARMIN_PASSWORD` or `GARMIN_SESSION_TOKEN`, not both.
>
> ⚠️ If your password contains `#` or other special characters, wrap it in **double quotes** — otherwise `#` and everything after it will be treated as a comment:
> ```
> GARMIN_PASSWORD="my#secret!pass"
> ```

### 4. Run

```bash
npx --legacy-peer-deps=false @deepseek-ai/dsh web
```

Open `http://127.0.0.1:3080`. The plugin is loaded when **Settings → Plugins → Plugin list** shows `plugin-garmin-connect` as *mounted & enabled*. Then try: *"How was my sleep last night?"* or *"Show me my last 5 runs."*

### 5. Integration Test (optional)

After configuring `.env`, you can run the integration test to verify all API connections:

```bash
npm run test:integration
```

<details>
<summary>📋 Click to expand sample output</summary>

```
🔌 Garmin Connect Integration Test
   Domain : garmin.com
   User   : your-email@example.com
   Date   : 2026-08-18

── 1. Login ──
  ✅ Login successful

── 2. Activities ──
  ✅ Got 3 activities
{
  "id": 23998327113,
  "name": "Wuhan Running",
  "type": "running",
  "startTime": "2026-08-16 19:33:05",
  "distanceMeters": 10017.73,
  "durationSeconds": 3965,
  "averageHeartRate": 145,
  "maxHeartRate": 180,
  "averagePaceMinPerKm": 6.6,
  "calories": 656,
  "elevationGainMeters": 4,
  "averageCadence": 141.78
}

── 3. Sleep ──
  ✅ Sleep score: 82, duration: 7.5h

── 4. Steps ──
  ✅ Steps: {
  "date": "2026-08-18",
  "totalSteps": 8523,
  "goal": 10000,
  "distanceMeters": 6120,
  "highlyActiveSeconds": 1800
}

── 5. Heart Rate ──
  ✅ Resting HR: 42, Max: 98

── 6. Weight / Body Composition ──
  ✅ Weight: 70.5 kg, BMI: 22.3, Body Fat: 15.2%

── 7. Workouts / Calendar ──
  ✅ Got 5 planned workouts
{
  "id": 1422905279,
  "name": "跃升之阶",
  "description": "",
  "sportType": "running",
  "createdDate": "2025-12-28T19:28:56.0",
  "estimatedDurationMins": 94,
  "estimatedDistanceMeters": null
}

── 8. User Profile ──
  ✅ Profile: loaded

── 9. Export Session Token ──
  ✅ Token exported (oauth1 key: ********…)
   💡 To use token-based auth, save the full JSON to GARMIN_SESSION_TOKEN in .env

🏁 Integration test complete.
```

</details>

---

## Security

> **Your credentials never leave your machine.**

### Credential Resolution Order

```
1. Plugin config values (set on the plugin row in a profile patch / `--patch` overlay)
   ↓ fallback
2. Environment variables (.env / shell)
   ↓ fallback
3. Schema defaults
```

### Best Practices

| Practice | Status |
|---|---|
| Passwords loaded exclusively from `process.env` | ✅ |
| `.env` is in `.gitignore` | ✅ |
| Secrets marked with `role('secret')` in Cordis schema — excluded from trajectory logs | ✅ |
| Session token support — avoids storing password entirely | ✅ |
| Tool outputs never include raw credentials | ✅ |
| In-memory cache reduces API calls (rate-limit protection) | ✅ |

### Recommended: Use Session Tokens

For maximum security, log in once with a password, then export and store only the session token:

```
You (to DeepSeek agent): "Export my Garmin session token"

# Agent calls: export_garmin_session
# → Returns a token string

# Add to .env:
GARMIN_SESSION_TOKEN=<the-token>
# Remove the password:
# GARMIN_PASSWORD=
```

---

## Architecture

```
┌─────────────────────────────────────────┐
│         DeepSeek Harness (dsh)          │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │     dsh-plugin-garmin-connect     │  │
│  │                                   │  │
│  │  ┌─────────┐    ┌─────────────┐  │  │
│  │  │  Config  │───▶│ GarminClient│  │  │
│  │  │ (Schema) │    │  (cached)   │  │  │
│  │  └─────────┘    └──────┬──────┘  │  │
│  │                        │         │  │
│  │  ┌─────────────────────▼──────┐  │  │
│  │  │     Tool Registry          │  │  │
│  │  │  • get_garmin_activities   │  │  │
│  │  │  • get_garmin_sleep        │  │  │
│  │  │  • get_garmin_steps        │  │  │
│  │  │  • get_garmin_heart_rate   │  │  │
│  │  │  • get_garmin_weight       │  │  │
│  │  │  • get_garmin_workouts     │  │  │
│  │  │  • get_garmin_profile      │  │  │
│  │  │  • export_garmin_session   │  │  │
│  │  └────────────────────────────┘  │  │
│  └───────────────────────────────────┘  │
│                                         │
│               Cordis Runtime            │
└─────────────────────────────────────────┘
           │
           ▼
   connect.garmin.com
   (or connect.garmin.cn)
```

---

## Development

```bash
# Clone & install
git clone https://github.com/Likenttt/garmin-connect-plugin-for-dsh.git
cd dsh-plugin-garmin-connect
npm install

# Build
npm run build

# Watch mode
npm run dev

# Run tests
npm test
```

### Project Structure

```
src/
├── index.ts          # Plugin entry point (Cordis apply function)
├── config.ts         # Configuration schema with env-var resolution
├── client.ts         # Garmin API wrapper with caching
├── tools/
│   └── index.ts      # Tool definitions & registration
└── utils/
    ├── cache.ts       # In-memory TTL cache
    └── format.ts      # Raw-data → LLM-friendly formatters
```

---

## Publishing & Distribution

The package is a standard dsh bundle: `package.json` declares `dsh.bundle.patch` → `cordis.patch.yml`, and `files` ships the compiled `lib/`, both READMEs, and the patch file.

```bash
npm run build   # prepublishOnly also runs this automatically
npm publish
```

After publishing, users install with a single command:

```bash
npx --legacy-peer-deps=false @deepseek-ai/dsh plugin --profile web add dsh-plugin-garmin-connect
```

Distribution notes:

- **npm registry (recommended)** — the tarball ships prebuilt `lib/`, so no build permission is needed at install time.
- **Local checkout** — `npx --legacy-peer-deps=false @deepseek-ai/dsh plugin --profile web add .` links the source directory; run `npm install` first.
- **GitHub installs** — `npx --legacy-peer-deps=false @deepseek-ai/dsh plugin --profile web add github:<owner>/<repo>` fetches sources and runs the package's `prepare` script to build them (self-contained, pinned TypeScript via `npx`); pnpm ≥ 10 refuses to run the script until you allow it — `dsh` prints the exact `allowBuilds` key for the profile's `pnpm-workspace.yaml`.
- Add the `dsh-plugin` topic to your GitHub repository for discoverability.

---

## Roadmap

- [x] **Body Composition** — weight, BMI, body fat %
- [x] **Garmin Calendar** — planned workouts
- [ ] **Training Status** — VO2 Max, training load, recovery time
- [ ] **Webhook / Push** — real-time activity upload notifications
- [ ] **Multi-account** — support multiple Garmin accounts in one Harness session
- [ ] **OAuth 2.0** — migrate to official Garmin API when available for personal use

---

## License

[MIT](LICENSE)

---

## Acknowledgements

- [DeepSeek Harness](https://github.com/deepseek-ai/dsh) — the agentic coding runtime
- [Cordis](https://github.com/cordiverse/cordis) — the plugin lifecycle framework
- [garmin-connect](https://www.npmjs.com/package/garmin-connect) — unofficial Garmin Connect client for Node.js
