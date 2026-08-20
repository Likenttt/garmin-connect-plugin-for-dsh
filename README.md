# dsh-plugin-garmin-connect

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that brings your Garmin fitness & health data into the AI agent loop.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

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

This plugin connects [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to [Garmin Connect](https://connect.garmin.com/), exposing your wearable data as **AI-callable tools**. Once installed, the DeepSeek agent can automatically query your activities, sleep, steps, and heart rate to provide personalized fitness insights — all through natural language.

### Registered Tools

The plugin registers **9 tools**. Eight are read-only; `create_garmin_workout`
changes the user's Garmin workout library.

| Tool | Description | Example Args |
|---|---|---|
| `get_garmin_activities` | Fetch recent activities (runs, rides, swims…) with compact or full detail | `{"limit": 5, "detail": "compact"}` |
| `get_garmin_sleep` | Sleep score, duration, and stage breakdown for a date or range | `{"startDate": "2023-10-01", "endDate": "2023-10-02"}` |
| `get_garmin_steps` | Step totals for a date or range; goal/distance appear only when Garmin supplies them | `{"startDate": "2023-10-01"}` |
| `get_garmin_heart_rate` | Resting, max, and min heart rate for a date or range | `{"startDate": "2023-10-01", "endDate": "2023-10-02"}` |
| `get_garmin_weight` | Body composition (weight, BMI, body fat %, muscle mass, etc.) for a date or range | `{"startDate": "2023-10-01"}` |
| `get_garmin_workouts` | Workout templates from your Garmin workout library (not calendar scheduling) | `{"limit": 10, "offset": 0}` |
| `get_garmin_profile` | User profile summary | `{}` or omit |
| `get_running_skill_advice` | Expert running coaching: 8 core training skills with HR zones, practice methods & common mistakes | `{"query": "threshold", "includeRecentActivities": true}` |
| `create_garmin_workout` | Preview a structured workout; create it only after explicit confirmation | `{"name": "Threshold 3×8min", "steps": [...]}` |

Workout creation is a two-call flow. The preview response includes a one-time
`confirmationId`; after the user approves the unchanged preview, call the tool
again with the same definition, `confirmed: true`, and that `confirmationId`.
An ID expires after 10 minutes and cannot be reused.

---

## Quick Start

> **Testing this unreleased checkout:** the hardening changes in `Unreleased`
> have intentionally not been published or version-bumped. Use the local
> checkout install below to test them; the registry command installs the
> currently published `0.1.4` package.

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
cd garmin-connect-plugin-for-dsh && npm install
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

The plugin does not persist credentials itself. Use environment variables (or a
secret store provided by your launcher) and keep `.env` out of version control.

```bash
# Source checkout only: copy the bundled template
cp .env.example .env

# Edit .env and fill in your Garmin credentials
```

For a registry installation, create `.env` directly in the directory where you
run `dsh` (your workspace root), then add the variables from the table below;
the package's template is inside the installed dependency rather than your
current directory. The plugin loads the workspace `.env` automatically.

| Variable | Required | Description |
|---|---|---|
| `GARMIN_USERNAME` | ✅ | Your Garmin account email |
| `GARMIN_PASSWORD` | ✅* | Account password |
| `GARMIN_SESSION_TOKEN` | ✅* | Pre-authenticated token (alternative to password) |
| `GARMIN_REGION` | ❌ | `global` (default) or `cn` for Garmin China |
| `GARMIN_CACHE_TTL` | ❌ | Cache duration in seconds (default: `300`) |
| `GARMIN_REQUEST_TIMEOUT_MS` | ❌ | Garmin request timeout in milliseconds (default: `15000`) |
| `GARMIN_LOG_LEVEL` | ❌ | `debug` \| `info` \| `warn` \| `error` |
| `GARMIN_ACTIVITY_DETAIL` | ❌ | `compact` (default) or `full` (expanded fitness plus precise route/location fields; credentials and account/social identifiers are filtered) |

> \* You need **either** `GARMIN_PASSWORD` or `GARMIN_SESSION_TOKEN`, not both.
>
> ⚠️ If your password contains `#` or other special characters, wrap it in **double quotes** — otherwise `#` and everything after it will be treated as a comment:
> ```
> GARMIN_PASSWORD="my#secret!pass"
> ```
>
> `GARMIN_SESSION_TOKEN` is supported, but it is just as sensitive as a
> password. Token export is intentionally not AI-callable. Until a dedicated
> local CLI / secure-store flow is available, use only a token obtained through
> an existing trusted local workflow and never paste it into an AI conversation.

### 4. Run

```bash
npx --legacy-peer-deps=false @deepseek-ai/dsh web
```

Open `http://127.0.0.1:3080`. The plugin is loaded when **Settings → Plugins → Plugin list** shows `plugin-garmin-connect` as *mounted & enabled*. Then try: *"How was my sleep last night?"* or *"Show me my last 5 runs."*

### 5. Integration Test (optional, source checkout only)

The integration script is a development aid and is not included in the npm
tarball. From a source checkout with development dependencies installed, you
can run it after configuring `.env`:

```bash
npm run test:integration
```

The script checks read-only APIs and exits non-zero if any check fails. It does
not create, update, or delete workouts or other Garmin data.

By default it hides the account identifier and prints only counts/status, not
activity or health values. Set `GARMIN_INTEGRATION_VERBOSE=true` only when you
explicitly want normalized details in your local terminal output.

<details>
<summary>📋 Click to expand sample output</summary>

```
🔌 Garmin Connect Integration Test
   Domain : garmin.com
   User   : configured (identifier hidden)
   Date   : 2026-08-18
   Scope  : read-only (workout creation/update/deletion is not tested)

── 1. Authentication ──
  ✅ Password login successful

── 2. Activities ──
  ✅ Got 3 activities

── 3. Sleep ──
  ✅ Sleep data loaded

── 4. Steps ──
  ✅ Step data loaded

── 5. Heart Rate ──
  ✅ Heart-rate data loaded

── 6. Weight / Body Composition ──
  ✅ Body-composition data loaded

── 7. Workout Library ──
  ✅ Got 5 workout templates

── 8. User Profile ──
  ✅ Profile loaded

🏁 Integration test complete: 8 passed, 0 failed.
   Write operations were intentionally not tested.
```

</details>

---

## Security

> **Credentials are used locally to authenticate directly with Garmin Connect
> and are never returned by an AI tool.**

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
| Environment-variable and secret-marked configuration are supported | ✅ |
| `.env` is in `.gitignore` | ✅ |
| Account identifier and credentials marked with `role('secret')` in Cordis schema | ✅ |
| Session token support — avoids storing the Garmin account password | ✅ |
| Tool outputs never include raw credentials | ✅ |
| In-memory cache reduces API calls (rate-limit protection) | ✅ |

### Session Tokens

Session-token authentication remains supported, but tokens are credentials and
must not appear in agent output or trajectory logs. For that reason this plugin
does not expose token export as an AI-callable tool. A dedicated local CLI /
secure-store workflow is planned. Until it is available, use username/password
or provide a token only through an existing trusted local workflow.

---

## Use with Other AI Coding Agents (MCP)

This plugin also ships as a standalone **MCP (Model Context Protocol) server**, so you can use the same Garmin tools with OpenAI Codex, Claude Code, Claude Desktop, Cursor, Windsurf, and any other MCP-compatible client — no DeepSeek Harness required.

> **Current availability:** npm `0.1.4` predates the MCP entry point. Until a
> newer MCP-capable version is published, use a local checkout; the registry
> `npx` command shown below is intentionally marked as future use.

Build the local server first:

```bash
git clone https://github.com/Likenttt/garmin-connect-plugin-for-dsh.git
cd garmin-connect-plugin-for-dsh
npm install
npm run build
```

Replace `/absolute/path/to/garmin-connect-plugin-for-dsh` in the examples with
the checkout's actual absolute path.

The command-line examples below expect Garmin credentials in the launching
shell. Do not type a real password directly into a command that will be saved
in shell history. For bash/zsh, read it without echoing, or inject it with your
usual OS/shell secret manager:

```bash
export GARMIN_USERNAME='your@email.com'
export GARMIN_REGION='global'
printf 'Garmin password: ' >&2
IFS= read -r -s GARMIN_PASSWORD
printf '\n' >&2
export GARMIN_PASSWORD
```

### OpenAI Codex (app, CLI, and IDE extension)

Codex clients on the same host share `~/.codex/config.toml`. The recommended
setup forwards credential variable names from the environment instead of
copying their values into TOML. With the variables above available to the Codex
process, add this entry to `~/.codex/config.toml`:

```toml
[mcp_servers.garmin-connect]
command = "node"
args = ["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"]
env_vars = ["GARMIN_USERNAME", "GARMIN_PASSWORD", "GARMIN_REGION"]

# Read tools can run normally; Codex asks before the non-read-only workout tool.
default_tools_approval_mode = "writes"
```

The Codex process must inherit the exported variables. If the desktop app was
launched outside that shell, add the server through **Settings → MCP servers**
and provide its environment there, or launch it through your usual secret-aware
environment. Values entered in Settings are local credentials; protect the
resulting configuration file.

For a trusted-project-only setup, put the same table in `.codex/config.toml`
inside that project. Restart the Codex client after editing the file, then
inspect the saved configuration:

```bash
codex mcp list
codex mcp get garmin-connect
```

Inside Codex CLI, use `/mcp` to verify that the server is active and inspect
its tools. The
[official Codex MCP documentation](https://developers.openai.com/codex/mcp/)
also covers the Settings UI and `codex mcp add` command.

### Claude Code

Garmin is normally a personal server, so user scope is a good default. The
following bash/zsh example keeps credential values out of `~/.claude.json`:

```bash
claude mcp add-json --scope user garmin-connect \
  '{"type":"stdio","command":"node","args":["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"],"env":{"GARMIN_USERNAME":"${GARMIN_USERNAME}","GARMIN_PASSWORD":"${GARMIN_PASSWORD}","GARMIN_REGION":"${GARMIN_REGION:-global}"}}'
```

Use `--scope local` instead if the server should be available only in the
current project. Keep the environment variables available whenever you launch
Claude Code—repeat the hidden input above or use a secret manager—then verify
the connection:

```bash
claude mcp get garmin-connect
claude mcp list
```

Inside Claude Code, `/mcp` shows connection status and the exposed tools. See
the [official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)
for scope and `.mcp.json` details. Do not commit personal Garmin credentials in
a project-scoped configuration.

### Using the tools in Codex or Claude Code

Once `garmin-connect` reports as connected, ask naturally; the client selects
the MCP tool. If tool selection is ambiguous, explicitly say “use the
garmin-connect MCP server.” For example:

- “Use garmin-connect to show my last five runs.”
- “Compare my sleep and resting heart rate over the last seven days.”
- “Preview a threshold workout, show me the steps, and do not create it until I approve.”

Workout creation still follows the enforced two-call confirmation flow: the
first call only previews, and creation requires your approval plus the returned
one-time `confirmationId`.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "garmin-connect": {
      "command": "node",
      "args": ["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"],
      "env": {
        "GARMIN_USERNAME": "your@email.com",
        "GARMIN_PASSWORD": "yourpassword",
        "GARMIN_REGION": "global"
      }
    }
  }
}
```

Restart Claude Desktop. You'll see a 🔌 icon indicating the tools are loaded. Try: *"Show my last 5 runs"* or *"Preview a threshold workout"*.

### Cursor

Add the same `mcpServers.garmin-connect` object shown above to the workspace's
`.cursor/mcp.json`, using the absolute `lib/mcp.js` path.

### Windsurf

Open **Windsurf Settings → Cascade → MCP Servers**, or edit
`~/.codeium/windsurf/mcp_config.json`, and add the same
`mcpServers.garmin-connect` object shown above.

The Claude Desktop, Cursor, and Windsurf JSON examples store credentials in
their client configuration. Restrict those files' permissions, never commit
them, or use a client-supported secret-injection mechanism. The Codex and
Claude Code examples above forward environment variables so raw credential
values do not need to be written into their MCP configuration.

After a version containing the MCP executable is published to npm, the local
`node …/lib/mcp.js` command can be replaced with:

```bash
npx -y --package dsh-plugin-garmin-connect garmin-connect-mcp
```

### Manual Run

```bash
# Run the MCP server (stdin/stdout)
GARMIN_USERNAME=xxx GARMIN_PASSWORD=xxx node lib/mcp.js
```

The MCP server exposes the same **9 tools and argument semantics** as the dsh
plugin: activities, sleep, steps, heart rate, weight, workout-library templates,
profile, running skills, and workout preview/creation. Session-token export is
intentionally unavailable through either AI interface.

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
│  │  ┌─────────────────────▼───────┐ │  │
│  │  │      Tool Registry (9)      │ │  │
│  │  │  • get_garmin_activities    │ │  │
│  │  │  • get_garmin_sleep         │ │  │
│  │  │  • get_garmin_steps         │ │  │
│  │  │  • get_garmin_heart_rate    │ │  │
│  │  │  • get_garmin_weight        │ │  │
│  │  │  • get_garmin_workouts      │ │  │
│  │  │  • get_garmin_profile       │ │  │
│  │  │  • get_running_skill_advice │ │  │
│  │  │  • create_garmin_workout    │ │  │
│  │  └─────────────────────────────┘ │  │
│  └───────────────────────────────────┘  │
│               Cordis Runtime            │
└────────────────┬────────────────────────┘
                 │
      ┌──────────┴──────────┐
      ▼                     ▼
connect.garmin.com    MCP Server (stdio)
connect.garmin.cn     → Claude Desktop / Claude Code /
                        Codex / Cursor / Windsurf
```

---

## Development

```bash
# Clone & install
git clone https://github.com/Likenttt/garmin-connect-plugin-for-dsh.git
cd garmin-connect-plugin-for-dsh
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
├── tool-service.ts   # Shared tool behavior for dsh and MCP
├── mcp.ts            # Standalone MCP adapter for Codex/Claude Code/other clients
├── knowledge/
│   ├── running-skills.ts  # 8-skill running coaching knowledge base
│   └── workout-schema.ts  # Workout definition → Garmin JSON builder
├── tools/
│   └── index.ts      # Tool definitions & registration (9 tools)
└── utils/
    ├── errors.ts      # Safe public errors and upstream-log redaction
    ├── cache.ts       # In-memory TTL/LRU cache with single-flight refresh
    ├── date.ts        # Local calendar-date parsing
    └── format.ts      # Raw-data → LLM-friendly formatters
```

---

## Publishing & Distribution

The package is a standard dsh bundle: `package.json` declares `dsh.bundle.patch` → `cordis.patch.yml`, and `files` ships the compiled `lib/`, `.env.example`, both READMEs, and the patch file.

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
- **GitHub installs** — `npx --legacy-peer-deps=false @deepseek-ai/dsh plugin --profile web add github:<owner>/<repo>` fetches sources and runs the package's `prepare` script with the locally installed TypeScript compiler; pnpm ≥ 10 refuses to run the script until you allow it — `dsh` prints the exact `allowBuilds` key for the profile's `pnpm-workspace.yaml`.
- Add the `dsh-plugin` topic to your GitHub repository for discoverability.

---

## Roadmap

- [x] **Body Composition** — weight, BMI, body fat %
- [x] **Workout Library** — list reusable Garmin workout templates
- [x] **Workout Creation** — safely preview and create structured workout-library entries
- [x] **MCP Server** — use with Codex, Claude Code/Desktop, Cursor, Windsurf
- [x] **Running Coach** — 8-skill training knowledge base
- [ ] **Training Status** — VO2 Max, training load, recovery time
- [ ] **Multi-account Sync** — sync activities between CN ↔ Global accounts
  - [ ] `list_garmin_accounts` — list configured accounts with connection status
  - [ ] `compare_garmin_accounts` — diff activities across two accounts (fuzzy match by time + distance + type)
  - [ ] `sync_garmin_activity` — download FIT from source account → upload to target account
  - [ ] Duplicate detection — skip activities that already exist in the target
  - [ ] Env vars: `GARMIN_USERNAME_2` / `GARMIN_PASSWORD_2` / `GARMIN_REGION_2` (fully backward-compatible)
- [ ] **Webhook / Push** — real-time activity upload notifications
- [ ] **OAuth 2.0** — migrate to official Garmin API when available for personal use

---

## License

[MIT](LICENSE)

---

## Acknowledgements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the agentic coding runtime
- [Cordis](https://github.com/cordiverse/cordis) — the plugin lifecycle framework
- [garmin-connect](https://www.npmjs.com/package/garmin-connect) — unofficial Garmin Connect client for Node.js
