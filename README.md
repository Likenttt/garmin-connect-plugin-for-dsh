# dsh-plugin-garmin-connect

> A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin that brings your Garmin fitness & health data into the AI agent loop.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

---

## What It Does

This plugin connects [DeepSeek Harness](https://github.com/deepseek-ai/dsh) to [Garmin Connect](https://connect.garmin.com/), exposing your wearable data as **AI-callable tools**. Once installed, the DeepSeek agent can automatically query your activities, sleep, steps, and heart rate to provide personalized fitness insights — all through natural language.

### Registered Tools

| Tool | Description |
|---|---|
| `get_garmin_activities` | Fetch recent activities (runs, rides, swims…) with pace, HR, calories |
| `get_garmin_sleep` | Sleep score, duration, and stage breakdown (deep / light / REM) |
| `get_garmin_steps` | Daily step count, goal progress, and walking distance |
| `get_garmin_heart_rate` | Resting, max, and min heart rate for a given day |
| `get_garmin_profile` | User profile summary |
| `export_garmin_session` | Export a session token for password-free future logins |

---

## Quick Start

### 1. Install

```bash
npm install dsh-plugin-garmin-connect
```

### 2. Configure Credentials

This plugin **never** stores passwords in config files or logs. Credentials are resolved through environment variables.

```bash
# Copy the template
cp .env.example .env

# Edit .env and fill in your Garmin credentials
```

| Variable | Required | Description |
|---|---|---|
| `GARMIN_USERNAME` | ✅ | Your Garmin account email |
| `GARMIN_PASSWORD` | ✅* | Account password |
| `GARMIN_SESSION_TOKEN` | ✅* | Pre-authenticated token (alternative to password) |
| `GARMIN_REGION` | ❌ | `global` (default) or `cn` for Garmin China |
| `GARMIN_CACHE_TTL` | ❌ | Cache duration in seconds (default: `300`) |
| `GARMIN_LOG_LEVEL` | ❌ | `debug` \| `info` \| `warn` \| `error` |

> \* You need **either** `GARMIN_PASSWORD` or `GARMIN_SESSION_TOKEN`, not both.

### 3. Enable in DeepSeek Harness

Add the plugin to your Harness configuration:

```yaml
# dsh config (e.g., dsh.config.yml)
plugins:
  garmin-connect:
    username: ${GARMIN_USERNAME}   # resolved from env
    # password and sessionToken are auto-loaded from env
    region: global
    cacheTtl: 300
```

### 4. Run

```bash
npx @deepseek-ai/dsh web
```

Then try: *"How was my sleep last night?"* or *"Show me my last 5 runs."*

---

## Security

> **Your credentials never leave your machine.**

### Credential Resolution Order

```
1. Plugin config values (dsh.config.yml)
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
git clone https://github.com/your-org/dsh-plugin-garmin-connect.git
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

## Roadmap

- [ ] **Body Composition** — weight, BMI, body fat %
- [ ] **Training Status** — VO2 Max, training load, recovery time
- [ ] **Garmin Calendar** — planned workouts, sync with scheduling plugins
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
