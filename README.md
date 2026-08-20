# dsh-plugin-garmin-connect

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that brings your Garmin fitness & health data into the AI agent loop.

[![npm version](https://img.shields.io/npm/v/dsh-plugin-garmin-connect.svg?logo=npm)](https://www.npmjs.com/package/dsh-plugin-garmin-connect)
[![npm downloads](https://img.shields.io/npm/dm/dsh-plugin-garmin-connect.svg?logo=npm)](https://www.npmjs.com/package/dsh-plugin-garmin-connect)
[![CI](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | **[简体中文](README.zh-CN.md)**

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

The plugin registers **10 tools**. Eight return Garmin data without writing;
`download_garmin_activity_fit` writes one local file on the MCP/dsh host, and
`create_garmin_workout` changes the user's Garmin workout library.

| Tool | Description | Example Args |
|---|---|---|
| `get_garmin_activities` | Fetch recent activities (runs, rides, swims…) with compact or full detail | `{"limit": 5, "detail": "compact"}` |
| `get_garmin_sleep` | Sleep score, duration, and stage breakdown for a date or range | `{"startDate": "2023-10-01", "endDate": "2023-10-02"}` |
| `get_garmin_steps` | Step totals for a date or range; goal/distance appear only when Garmin supplies them | `{"startDate": "2023-10-01"}` |
| `get_garmin_heart_rate` | Resting, max, and min heart rate for a date or range | `{"startDate": "2023-10-01", "endDate": "2023-10-02"}` |
| `get_garmin_weight` | Body composition (weight, BMI, body fat %, muscle mass, etc.) for a date or range | `{"startDate": "2023-10-01"}` |
| `get_garmin_workouts` | Workout templates from your Garmin workout library (not calendar scheduling) | `{"limit": 10, "offset": 0}` |
| `get_garmin_profile` | User profile summary | `{}` or omit |
| `get_running_skill_advice` | Explain 8 workout types and 4 training philosophies, or collect the mandatory intake for personalized coaching | `{"mode": "explain", "query": "Daniels", "language": "en"}` |
| `download_garmin_activity_fit` | Download an activity's original archive and safely extract its single FIT file to the account directory under the configured host parent | `{"activityId": 123456789}` |
| `create_garmin_workout` | Preview a structured workout; create it only after explicit confirmation | `{"name": "Threshold 3×8min", "steps": [...]}` |

Workout creation is a two-call flow. The preview response includes a one-time
`confirmationId`; after the user approves the unchanged preview, call the tool
again with the same definition, `confirmed: true`, and that `confirmationId`.
An ID expires after 10 minutes and cannot be reused.

### Personalized running coaching

`get_running_skill_advice` deliberately separates explanation from planning:

- `mode: "explain"` explains a workout type or training philosophy. It does not
  invent an athlete-specific schedule.
- `mode: "personalized"` is required for any recommendation or plan. Before it
  returns planning material, the tool requires answers for all six intake areas
  below. Missing answers are returned as focused questions; Garmin activity data
  is not fetched and a schedule must not be generated yet.

| Intake field | What the assistant must ask |
|---|---|
| `goal` | Target distance/event, future ISO `YYYY-MM-DD` date, and completion or ideal/minimum time goal |
| `currentPerformance` + `performanceBasis` | A representative race/time trial from the past two years, result, non-future date, effort/conditions, or an explicit `no_recent_benchmark` |
| `trainingBackground` | Running history and recent 4–8 week volume, frequency, long run, quality work, and interruptions |
| `availability` | Available days/time, fixed rest and long-run days, terrain/facility limits, strength-training time, and whether double days are possible |
| `healthConstraints` + `hasWarningSymptoms` | Current/past-year injury, pain, relevant disease/medication, sleep and recovery, plus an explicit warning-symptom boolean |
| `trainingPreference` + preference details | `steady`, `hard_easy`, or `mixed`, plus `maxQualitySessionsPerWeek` (0–7) and `intensityGuidancePreference` (`pace`, `heart_rate`, `rpe`, or `mixed`) |

If `hasWarningSymptoms` is true—for example current chest discomfort,
unusual breathlessness with mild activity, fainting/dizziness, or abnormal
palpitations—the tool returns a safety stop without workout material or Garmin
activity access. It advises medical clearance and does not diagnose. If
`performanceBasis` is `no_recent_benchmark`, planning material instructs the
assistant to begin with easy base work or a low-risk benchmark instead of
inventing precise threshold or interval paces.

The compact philosophy layer contains:

- **Hansons** — frequent, more evenly distributed mileage, pace discipline, and
  cumulative fatigue; its 16-mile long run is not a standalone prescription.
- **Jack Daniels** — derive VDOT and E/M/T/I/R intensity from current, recent
  performance, never from the goal time.
- **Norwegian threshold** — borrow controlled, non-exhaustive threshold work and
  hard/easy separation; double-threshold days are not prescribed by default.
- **Polarized training** — keep most work genuinely easy and a small amount
  clearly hard; 80/20 is a direction rather than an exact quota.

Recent Garmin runs may supplement this intake but never replace the athlete's
answers. The method notes and evidence boundaries are summarized in
[the training-method research note](docs/research/running-training-methods.md).
Each philosophy and workout-card output labels its statements as
`system_principle`, `research_evidence`, or `application_inference` so a method
definition or coaching inference is not misrepresented as comparative proof.

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
| `GARMIN_PASSWORD` | ✅* | Legacy direct-login password; do not use this for the interactive MFA setup below |
| `GARMIN_SESSION_TOKEN` | ✅* | Inline pre-authenticated token (supported, but the session file is safer) |
| `GARMIN_SESSION_TOKEN_FILE` | ✅* | Path to the private OAuth session file generated by the local auth command |
| `GARMIN_REGION` | ❌ | `global` (default) or `cn` for Garmin China |
| `GARMIN_FIT_DOWNLOAD_DIR` | FIT only | User-selected host parent directory for FIT exports; no default |
| `GARMIN_CACHE_TTL` | ❌ | Cache duration in seconds (default: `300`) |
| `GARMIN_REQUEST_TIMEOUT_MS` | ❌ | Garmin request timeout in milliseconds (default: `15000`) |
| `GARMIN_LOG_LEVEL` | ❌ | `debug` \| `info` \| `warn` \| `error` |
| `GARMIN_ACTIVITY_DETAIL` | ❌ | `compact` (default) or `full` (expanded fitness plus precise route/location fields; credentials and account/social identifiers are filtered) |

> \* You need one of `GARMIN_PASSWORD`, `GARMIN_SESSION_TOKEN`, or
> `GARMIN_SESSION_TOKEN_FILE`. The file is recommended, especially for MFA and
> multiple accounts. If more than one is configured, the inline token takes
> precedence over the file, and a valid session takes precedence over password
> login.
>
> ⚠️ If your password contains `#` or other special characters, wrap it in **double quotes** — otherwise `#` and everything after it will be treated as a comment:
> ```
> GARMIN_PASSWORD="my#secret!pass"
> ```
>
> `GARMIN_SESSION_TOKEN` and the contents of `GARMIN_SESSION_TOKEN_FILE` are as
> sensitive as a password. Token export is intentionally not AI-callable; never
> paste a token into an AI conversation.

#### Accounts with two-step verification (unreleased local checkout)

Run the one-time setup yourself in a trusted local terminal, from this source
checkout. Choose the region that belongs to the account:

```bash
# Garmin International
npm run auth:setup -- --account personal --region global

# Garmin China
npm run auth:setup -- --account personal --region cn
```

`auth:setup` is the source-checkout npm-script alias. The stable executable name
for an installed package is `garmin-connect-auth`, so Codex, Claude Code, and
other local clients can all point users to the same bootstrap command:

```bash
garmin-connect-auth --help
garmin-connect-auth login --account personal --region global
```

Direct invocation requires an installation that places npm executables on
`PATH`, normally a global install; a nested dsh dependency or an ordinary local
dependency does not do that. To test the current checkout as a system command,
you can explicitly run `npm install -g .` from the repository first. After a
future package version is published, either install that version globally or
use this pattern from your own terminal, replacing `PUBLISHED_VERSION`:

```bash
npx -y --package dsh-plugin-garmin-connect@PUBLISHED_VERSION \
  garmin-connect-auth login --account personal --region global
```

The currently published npm `0.1.4` package predates this executable. Until a
later prerelease or release containing it is installed, use the source-checkout
`npm run auth:setup -- ...` command above. In either form, run it yourself in a
trusted interactive terminal. The local MCP/plugin process may read the
resulting session file by its configured path; Codex, Claude Code, the model,
and other agents must never read or copy the file contents, password, or MFA
code.

The command asks for the email, password, and—only when Garmin challenges the
login—the verification code. Password and MFA code are entered with terminal
echo disabled. They are not accepted as command-line flags, environment
variables, MCP tool arguments, or model input. Run this command directly; do
not ask Codex, Claude Code, or another agent to type the secrets through its
terminal tool.

On success, the command prints the path to an OAuth session file and saves only
that session. On POSIX it uses owner-only mode `0600`; on Windows it uses the
current user's config directory but does not yet validate Windows ACLs. It does
not save the password or MFA code. Configure the runtime with the printed path, then omit
`GARMIN_PASSWORD`:

```dotenv
GARMIN_USERNAME=your-email@example.com
GARMIN_REGION=global
GARMIN_SESSION_TOKEN_FILE=/absolute/path/to/personal.session.json
GARMIN_FIT_DOWNLOAD_DIR=/absolute/path/to/garmin-fit-parent
```

New files also contain an account binding: the username is trimmed,
Unicode-normalized (NFKC), lower-cased, and stored only as a one-way SHA-256
digest, together with `region`. The plaintext email is not duplicated in the
binding. At runtime, a username/region mismatch is rejected before OAuth tokens
are loaded, which helps prevent accidentally using one account's health data
under another account configuration.

For backward compatibility, legacy session files containing only the two
`oauth1` and `oauth2` fields are still accepted. They have no binding to check;
regenerate them with `auth:setup` when practical to gain the mismatch guard.
On POSIX, a legacy file must still pass the current owner-only file-permission
check (normally mode `0600`).

On POSIX, the default account directory is created with owner-only permissions. To choose
a different session file, add `--output /absolute/private/path/personal.session.json`.
On POSIX systems, an existing parent directory must grant no permissions to
group or other users (normally mode `0700`); a missing parent is created
owner-only. The command refuses an unsafe parent instead of weakening it.

This MFA bootstrap uses Garmin's private SSO flow. It is experimental and has
not yet completed an end-to-end test with a real MFA-enabled account; keep the
checkout unpublished until the relevant global/China login flow is verified.

#### Multiple accounts: one isolated process per account

The simplest multi-account setup is supported now: run `auth:setup` once for
each account alias, producing a separate session file, then configure a
separate dsh profile or MCP server/process for each account. Give each process
its own `GARMIN_USERNAME`, `GARMIN_REGION`, and `GARMIN_SESSION_TOKEN_FILE`.
The processes may share one `GARMIN_FIT_DOWNLOAD_DIR` parent: the plugin creates
a separate account subdirectory from each configured email. For example, name
the servers `garmin-personal` and `garmin-family` and select the intended server
in the request.

This is process isolation, not an in-process account selector or a multi-tenant
authorization system. Do not expose one shared MCP process to mutually
untrusted users; per-user access control has not been implemented.

#### FIT downloads

`download_garmin_activity_fit` accepts only an activity ID; the model cannot
choose an arbitrary output path. Garmin's original activity ZIP is downloaded
to a private temporary location, size-checked, and required to contain exactly
one valid FIT file. Given a configured parent directory `<base>`, the result is
written as `<base>/GARMIN_FIT_<user-email>/<activityId>.fit` without overwriting
an existing file. Here `<user-email>` is safely normalized: a normal email
address remains recognizable, while path separators, control characters, and
other unsafe filename characters are normalized before the account directory
is created. The user locates the file from the configured parent plus this
rule. The tool returns only `activityId`, `fileName`, `sizeBytes`, and `sha256`;
it does not return the parent, account directory, email, or full path. ZIP/FIT
bytes never enter model context.

The parent directory has no default and must be chosen explicitly through
`GARMIN_FIT_DOWNLOAD_DIR`. It is required only when using this tool; if unset,
the tool fails before writing any file and all other Garmin tools remain
available. Multiple account processes can safely share the same parent because
their normalized-email subdirectories are isolated.

Garmin's “original” export is not guaranteed to be FIT. If the archive has no
single valid FIT entry, the tool fails safely instead of renaming another
format.

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
| Local MFA bootstrap stores only a private OAuth session file (`0600` on POSIX) | ✅ (experimental SSO) |
| New sessions bind a username SHA-256 digest plus region; legacy two-field sessions remain compatible | ✅ |
| Per-account session files support process-isolated multi-account setups | ✅ |
| Tool outputs never include raw credentials | ✅ |
| FIT bytes and local/account paths stay on the host; the model receives only activity/file name/size/hash | ✅ |
| In-memory cache reduces API calls (rate-limit protection) | ✅ |

### Session Tokens

Session-token authentication remains supported, but tokens are credentials and
must not appear in agent output or trajectory logs. For that reason this plugin
does not expose authentication, MFA submission, or token export as AI-callable
tools. Use the local `auth:setup` command above, then let dsh/MCP read the
owner-only file through `GARMIN_SESSION_TOKEN_FILE`; the runtime does not need
the account password. Newly generated files bind the normalized username's
one-way SHA-256 digest and region to the OAuth session; legacy unbound
`oauth1`/`oauth2` files remain readable for compatibility.

---

## Use with Other AI Coding Agents (MCP)

This plugin also ships as a standalone **MCP (Model Context Protocol) server**, so you can use the same Garmin tools with OpenAI Codex, Claude Code, Claude Desktop, Cursor, Windsurf, WorkBuddy, ZCode, and any other MCP-compatible client — no DeepSeek Harness required.

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

For an MFA account, first run the local `auth:setup` flow described above.
Then make the non-secret account/region plus the session-file path and FIT parent
directory available to the client process. These placeholders work with the
Codex, Claude Code, WorkBuddy, and ZCode examples below after you replace them
with absolute paths on your machine:

```bash
export GARMIN_USERNAME='your@email.com'
export GARMIN_REGION='global'
export GARMIN_SESSION_TOKEN_FILE='/absolute/path/to/personal.session.json'
export GARMIN_FIT_DOWNLOAD_DIR='/absolute/path/to/garmin-fit-parent'
```

Do not put a password or MFA code in these variables. The MCP server never
prompts for MFA; it starts from the saved OAuth session. Protect both the
session file and the FIT directory because downloaded activities may contain
precise location and health data.

### OpenAI Codex (app, CLI, and IDE extension)

Codex clients on the same host share `~/.codex/config.toml`. The recommended
setup forwards credential variable names from the environment instead of
copying their values into TOML. With the variables above available to the Codex
process, add this entry to `~/.codex/config.toml`:

```toml
[mcp_servers.garmin-connect]
command = "node"
args = ["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"]
env_vars = ["GARMIN_USERNAME", "GARMIN_REGION", "GARMIN_SESSION_TOKEN_FILE", "GARMIN_FIT_DOWNLOAD_DIR"]

# Read tools can run normally; Codex asks before local-file and Garmin writes.
default_tools_approval_mode = "writes"
```

This entry consumes the session file created once by `auth:setup`; Codex never
receives or prompts for the password/MFA code. For a second account, add another
server table such as `[mcp_servers.garmin-family]` with that account's separate
session file. It may reuse the same FIT parent directory; output is automatically
isolated under that account's normalized-email subdirectory.

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
following bash/zsh example keeps the session contents out of `~/.claude.json`;
only the owner-only file path is configured:

```bash
claude mcp add-json --scope user garmin-connect \
  '{"type":"stdio","command":"node","args":["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"],"env":{"GARMIN_USERNAME":"${GARMIN_USERNAME}","GARMIN_REGION":"${GARMIN_REGION:-global}","GARMIN_SESSION_TOKEN_FILE":"${GARMIN_SESSION_TOKEN_FILE}","GARMIN_FIT_DOWNLOAD_DIR":"${GARMIN_FIT_DOWNLOAD_DIR}"}}'
```

This server only reads the OAuth session produced by the local TTY flow; Claude
Code never receives or prompts for the password/MFA code. Register a differently
named server with a different session file for each additional account. Those
servers may reuse the same FIT parent directory.

Use `--scope local` instead if the server should be available only in the
current project. Keep the path variables available whenever you launch Claude
Code, then verify the connection:

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
- “Download the FIT file for activity 123456789 under my configured Garmin FIT parent.”
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
        "GARMIN_REGION": "global",
        "GARMIN_SESSION_TOKEN_FILE": "/absolute/path/to/personal.session.json",
        "GARMIN_FIT_DOWNLOAD_DIR": "/absolute/path/to/garmin-fit-parent"
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

### WorkBuddy

WorkBuddy Desktop supports local MCP servers at user and project scope. For
personal Garmin data, prefer the user-level `~/.workbuddy/mcp.json`. Open
**Plugins → MCP Servers → Configure MCP**, or edit that file directly, and add:

```json
{
  "mcpServers": {
    "garmin-connect": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"],
      "env": {
        "GARMIN_USERNAME": "your@email.com",
        "GARMIN_REGION": "global",
        "GARMIN_SESSION_TOKEN_FILE": "/absolute/path/to/personal.session.json",
        "GARMIN_FIT_DOWNLOAD_DIR": "/absolute/path/to/garmin-fit-parent"
      }
    }
  }
}
```

Use `command -v node` on macOS/Linux or `where node` on Windows to find the
absolute Node.js executable; GUI applications may not inherit an `nvm` shell
path. In JSON on Windows, use forward slashes such as `C:/.../node.exe`, or
escape each backslash as `\\`. Leave out `type` in WorkBuddy's local-command
format. Save the file and confirm that the server status turns green, then start
with a read-only request. See the [official WorkBuddy MCP guide](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide).

The session file in this entry must come from the local TTY `auth:setup` flow;
WorkBuddy never receives the password/MFA code. Add another named
`mcpServers` entry with a separate session file per account. Entries may share
the same FIT parent directory because account subdirectories are automatic.

### ZCode

Open **Settings → MCP Servers → New MCP Server**, choose **User** scope and
`stdio`, then enter the same absolute Node.js command, `lib/mcp.js` argument,
and Garmin environment variables. Alternatively, edit the native user config
at `~/.zcode/cli/config.json`:

```json
{
  "mcp": {
    "servers": {
      "garmin-connect": {
        "command": "/absolute/path/to/node",
        "args": ["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"],
        "env": {
          "GARMIN_USERNAME": "your@email.com",
          "GARMIN_REGION": "global",
          "GARMIN_SESSION_TOKEN_FILE": "/absolute/path/to/personal.session.json",
          "GARMIN_FIT_DOWNLOAD_DIR": "/absolute/path/to/garmin-fit-parent"
        }
      }
    }
  }
}
```

ZCode can also import an existing Codex or Claude Code MCP entry. Its generic
`~/.agents/mcp.json` support uses the `mcpServers` shape, but if the same scope's
`.zcode` config contains any MCP server, ZCode skips that `.agents` file rather
than merging it. See the [official ZCode MCP guide](https://zcode.z.ai/en/docs/mcp-services).

The session file in this entry must come from the local TTY `auth:setup` flow;
ZCode never receives the password/MFA code. Add another named server with a
separate session file per account. Servers may share the same FIT parent
directory because account subdirectories are automatic.

These configurations have been checked against both clients' published schemas;
an end-to-end WorkBuddy/ZCode smoke test with a real Garmin account has not yet
been recorded.

The Claude Desktop, Cursor, Windsurf, WorkBuddy, and ZCode JSON examples store
the sensitive session-file path in their client configuration, but not the
session contents, password, or MFA code. Restrict those files' permissions and
never commit them. The Codex and Claude Code examples forward path variables
instead. MCP results can place sleep, heart-rate, weight, activity, and location
data in the selected model's context; review that client's data controls and
keep activity detail at `compact` unless precise expanded data is necessary.
FIT bytes and the complete local/account path remain on the MCP host. Only the
activity ID, file name, size, and hash enter model context; locate the file
using your configured parent and the documented account-directory rule.

After a version containing the MCP executable is published to npm, the local
`node …/lib/mcp.js` command can be replaced with:

```bash
npx -y --package dsh-plugin-garmin-connect garmin-connect-mcp
```

### Manual Run

```bash
# Run the MCP server (stdin/stdout) after local auth:setup
GARMIN_USERNAME=xxx \
GARMIN_SESSION_TOKEN_FILE=/absolute/path/to/personal.session.json \
GARMIN_FIT_DOWNLOAD_DIR=/absolute/path/to/garmin-fit-parent \
node lib/mcp.js
```

The MCP server exposes the same **10 tools and argument semantics** as the dsh
plugin: activities, sleep, steps, heart rate, weight, workout-library templates,
profile, running skills, local FIT download, and workout preview/creation.
Authentication, MFA submission, and session-token export are intentionally
unavailable through either AI interface.

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
│  │  │      Tool Registry (10)     │ │  │
│  │  │  • get_garmin_activities    │ │  │
│  │  │  • get_garmin_sleep         │ │  │
│  │  │  • get_garmin_steps         │ │  │
│  │  │  • get_garmin_heart_rate    │ │  │
│  │  │  • get_garmin_weight        │ │  │
│  │  │  • get_garmin_workouts      │ │  │
│  │  │  • get_garmin_profile       │ │  │
│  │  │  • get_running_skill_advice │ │  │
│  │  │  • download activity FIT    │ │  │
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
                        Codex / Cursor / Windsurf /
                        WorkBuddy / ZCode
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
├── auth.ts           # Private-SSO authentication flow with local MFA callback
├── auth-cli.ts       # Private session bootstrap in a trusted local TTY
├── session-store.ts  # Strict session-file loading and atomic private writes
├── fit-export.ts     # Bounded, non-overwriting FIT extraction from original ZIP
├── tool-service.ts   # Shared tool behavior for dsh and MCP
├── mcp.ts            # Standalone MCP adapter for Codex/Claude Code/other clients
├── knowledge/
│   ├── running-skills.ts  # 8 workout types + 4 compact training philosophies
│   └── workout-schema.ts  # Workout definition → Garmin JSON builder
├── tools/
│   └── index.ts      # Tool definitions & registration (10 tools)
└── utils/
    ├── errors.ts      # Safe public errors and upstream-log redaction
    ├── cache.ts       # In-memory TTL/LRU cache with single-flight refresh
    ├── date.ts        # Local calendar-date parsing
    ├── path.ts        # FIT parent-directory expansion and resolution
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
- [x] **MCP Server** — use with Codex, Claude Code/Desktop, Cursor, Windsurf, WorkBuddy, ZCode
- [x] **Running Coach** — 8 workout types, 4 training philosophies, and mandatory personalized intake
- [x] **Local MFA Bootstrap (experimental)** — hidden TTY input and private OAuth session file (`0600` on POSIX); real MFA end-to-end verification still required
- [x] **Process-isolated Accounts** — one session file and one dsh profile/MCP process per account
- [x] **FIT Download** — safely extract one FIT from the original archive into an automatic normalized-email subdirectory under a user-selected parent
- [ ] **Training Status** — VO2 Max, training load, recovery time
- [ ] **Single-process Account Selector / Multi-tenant ACL** — explicit account routing and per-user authorization
- [ ] **Multi-account Sync** — sync activities between CN ↔ Global accounts
  - [ ] `list_garmin_accounts` — list configured accounts with connection status
  - [ ] `compare_garmin_accounts` — diff activities across two accounts (fuzzy match by time + distance + type)
  - [ ] `sync_garmin_activity` — download FIT from source account → upload to target account
  - [ ] Duplicate detection — skip activities that already exist in the target
  - [ ] Upload a verified source FIT to the explicitly selected target account
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
