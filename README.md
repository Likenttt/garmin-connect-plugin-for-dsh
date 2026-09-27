# dsh-plugin-garmin-connect
[![DSH Insights health](https://dsh-insights.com/badge/Likenttt/garmin-connect-plugin-for-dsh.svg)](https://dsh-insights.com/p/Likenttt/garmin-connect-plugin-for-dsh/)

> A TypeScript-based Garmin Connect plugin and MCP server with **secure browser-based MFA**, built for DeepSeek Harness and designed to work with other AI agents.

[![npm version](https://img.shields.io/npm/v/dsh-plugin-garmin-connect.svg?logo=npm)](https://www.npmjs.com/package/dsh-plugin-garmin-connect)
[![npm downloads](https://img.shields.io/npm/dm/dsh-plugin-garmin-connect.svg?logo=npm)](https://www.npmjs.com/package/dsh-plugin-garmin-connect)
[![CI](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/actions/workflows/ci.yml)
[![Test Report](https://img.shields.io/badge/test_report-view-blue.svg)](TEST_REPORT.md)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | **[简体中文](README.zh-CN.md)** | **[Test Report](TEST_REPORT.md)** | **[Changelog](CHANGELOG.md)**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/coding-agents-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/coding-agents-light.png">
    <img src="docs/assets/coding-agents-light.png" width="720" alt="DeepSeek Harness, WorkBuddy, Qwen Work, ZCode, Claude Code, Codex, Cursor, and Windsurf">
  </picture>
</p>
<p align="center">
  <strong>Works with mainstream coding agents and AI workspaces</strong><br>
  <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> ·
  <a href="https://www.codebuddy.cn/work/">WorkBuddy</a> ·
  <a href="https://qwenwork.cn/">Qwen Work</a> ·
  <a href="https://zcode.z.ai/">ZCode</a> ·
  <a href="https://www.anthropic.com/claude-code">Claude Code</a> ·
  <a href="https://openai.com/codex/">Codex</a> ·
  <a href="https://www.cursor.com/">Cursor</a> ·
  <a href="https://windsurf.com/">Windsurf</a><br>
  <sub>Connect through MCP or a <code>SKILL.md</code> workflow, depending on the client.</sub>
</p>

> [!NOTE]
> **MFA support in 0.1.6:** local dsh Web, the
> `garmin-connect-auth serve` system-browser flow, and MCP URL elicitation can
> bootstrap the same owner-only session for China and International accounts.
> Real-account MFA completed in both regions on 2026-08-29, including a full
> China-region browser-to-session-and-read chain and an International-region
> system-browser DI exchange with owner-only session persistence. Browser policy
> may still block an individual flow.
> The older `login --browser` command is retained only as a diagnostic.

---

## More Apps

| Icon | App | What it does |
|---|---|---|
| [<img src="https://wristtale.com/static/favicons/apple-touch-icon.png" width="32" height="32" alt="WristTale" />](https://wristtale.com) | [WristTale](https://wristtale.com) | Read TXT and Markdown on your Garmin watch |
| [<img src="https://jiake.app/app-icon.png" width="32" height="32" alt="JiaKe.app" />](https://jiake.app) | [JiaKe.app](https://jiake.app) | Turn Garmin screenshots into polished assets |
| [<img src="https://gamerasnap.com/static/images/appicon.png" width="32" height="32" alt="GameraSnap" />](https://gamerasnap.com) | [GameraSnap](https://gamerasnap.com) | Control your phone camera from your Garmin watch |
| [<img src="https://wristalbum.wristtale.com/app-icon.svg" width="32" height="32" alt="WristAlbum" />](https://wristalbum.wristtale.com) | [WristAlbum](https://wristalbum.wristtale.com) | Keep a private photo album on your Garmin |
| [<img src="https://wristpass.li2niu.com/static/favicons/apple-touch-icon.png" width="32" height="32" alt="WristPass" />](https://wristpass.li2niu.com) | [WristPass](https://wristpass.li2niu.com) | Keep cards and tickets ready on your wrist |
| [<img src="https://2fa4g.li2niu.com/static/branding/app-icon.png" width="32" height="32" alt="2FA4G" />](https://2fa4g.li2niu.com) | [2FA4G](https://2fa4g.li2niu.com) | Keep offline 2FA codes on your Garmin |

---

## What It Does

This plugin connects [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) or any MCP-compatible AI agent to [Garmin Connect](https://connect.garmin.com/), exposing your wearable data as **AI-callable tools**. Once installed, the agent can automatically query your activities, sleep, steps, and heart rate to provide personalized fitness insights — all through natural language.

### Registered Tools

The plugin registers **10 tools**. Eight return Garmin data without writing;
`download_garmin_activity_fit` writes one local file on the MCP/dsh host, and
`create_garmin_workout` changes the user's Garmin workout library.

| Tool | Description | Example Args |
|---|---|---|
| `get_garmin_activities` | Fetch recent activities (runs, rides, swims…) with full detail by default; `compact` is optional | `{"limit": 5}` |
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
[the training-method research note](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/blob/main/docs/research/running-training-methods.md).
Each philosophy and workout-card output labels its statements as
`system_principle`, `research_evidence`, or `application_inference` so a method
definition or coaching inference is not misrepresented as comparative proof.

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

Normal runtime credentials come from environment variables (or a secret store
provided by your launcher); keep `.env` out of version control. The local Web
MFA flow is the narrow exception: after explicit profile confirmation, the
Host atomically saves an owner-only DI session file. It never saves the password,
MFA code, or CAPTCHA response.

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
| `GARMIN_ACCOUNT` | ❌ | Lowercase local alias used for the implicit Web/CLI/MCP session path (`default` when omitted) |
| `GARMIN_PASSWORD` | ✅* | Legacy direct-login password; do not use this for the interactive MFA setup below |
| `GARMIN_SESSION_TOKEN` | ✅* | Inline pre-authenticated token (supported, but the session file is safer) |
| `GARMIN_SESSION_TOKEN_FILE` | ✅* | Path to the owner-only DI v2 (or compatible legacy OAuth) session file generated by the local auth command |
| `GARMIN_REGION` | ❌ | `global` (default) or `cn` for Garmin China |
| `GARMIN_FIT_DOWNLOAD_DIR` | FIT only | User-selected host parent directory for FIT exports; no default. The generated account directory includes `GARMIN_REGION` |
| `GARMIN_CACHE_TTL` | ❌ | Cache duration in seconds (default: `300`) |
| `GARMIN_REQUEST_TIMEOUT_MS` | ❌ | Garmin request timeout in milliseconds (default: `15000`) |
| `GARMIN_LOG_LEVEL` | ❌ | `debug` \| `info` \| `warn` \| `error` |
| `GARMIN_ACTIVITY_DETAIL` | ❌ | `full` (default; preserves available expanded activity-list fields, including lap counts and split summaries when Garmin supplies them; may include precise route/location) or `compact` (smaller output). Credentials and unrelated account/social identifiers are filtered. |

> \* Normal data access needs one of `GARMIN_PASSWORD`, `GARMIN_SESSION_TOKEN`,
> or `GARMIN_SESSION_TOKEN_FILE`. The local Web, `auth:serve`, and
> standalone MCP flows may start without one and create the implicit account
> session file. A protected file is safer than an inline token,
> especially when isolating multiple processes. If more than one is configured, the inline token takes
> precedence over the file until Garmin explicitly rejects it; a newly written,
> account-matching session file can then take over on retry. A valid session
> takes precedence over password login.
>
> ⚠️ If your password contains `#` or other special characters, wrap it in **double quotes** — otherwise `#` and everything after it will be treated as a comment:
> ```
> GARMIN_PASSWORD="my#secret!pass"
> ```
>
> `GARMIN_SESSION_TOKEN` and the contents of `GARMIN_SESSION_TOKEN_FILE` are as
> sensitive as a password. Token export is intentionally not AI-callable; never
> paste a token into an AI conversation.

#### Two-step verification — browser-based MFA

When dsh and its Web UI are running together on the same local machine, use the
**China account** or **International account** Garmin button in the top bar. The
selected button must match the process's configured `GARMIN_REGION`; a mismatch
fails before any Garmin page is opened. A matching selection opens a custom bridge on an ephemeral
`127.0.0.1` port; that bridge, rather than the dsh page itself, embeds Garmin's
official GAuth page. Email, password, MFA code, and any CAPTCHA are entered only
inside the Garmin iframe.

Making this safe and reliable required more than adding a verification-code
field. We first kept Garmin's official GAuth page inside a local iframe so the
email, password, and MFA code stayed on Garmin's origin, then worked through
cross-origin messaging, missing vendor styles, browser CSP/Trusted Types,
third-party-frame policy, MFA redirects, and exact ticket/service binding.
Inspired by Zhitao's [DailySync](https://dailysync.cn) approach of completing
Garmin SSO in a fresh browser tab, we added the system-browser loopback broker
used by CLI and MCP clients. The tab returns only a short-lived, one-time service
ticket; the Host immediately exchanges it for the longer-lived DI session and
refresh credentials, verifies the Garmin profile, and writes an owner-only
session. In other words, the ticket itself is not a one-year credential—the
potentially long-lived artifact is the exchanged session/refresh credential,
whose actual lifetime remains controlled by Garmin.

Garmin sends its short-lived service ticket only to the isolated loopback bridge.
The bridge validates the expected region, message origin, iframe source, service,
and ticket, then immediately hands it to the plugin Host for the region-bound DI
token exchange. Garmin China may bind an MFA ticket to the exact current
`http://127.0.0.1:<port>` bridge instead of the fixed Garmin embed URL; the
plugin preserves that ticket/service pair unchanged and rejects every other
loopback host, port, path, query, or region before contacting DI. It never
rewrites or retries the one-time ticket with a fallback service. The Host probes the Garmin profile, shows a sanitized profile to
the user, and asks them to confirm that it corresponds to the configured email.
Only then does it atomically save an owner-only session bound to the configured
account and region. The outer dsh page receives only
public progress states: the dsh page, model context, and AI-callable tool results
never receive the ticket, DI token, password, MFA code, or CAPTCHA response.

After the Host verifies the account through password login, a profile-bound DI
session, or a newly confirmed Web login, the matching region button subtitle
shows the verified account email as signed in; the other region keeps its
domain. Merely loading an identity-unverified legacy OAuth token does not show
this state, and the status endpoint never returns a ticket or token. The local
page refreshes this state every 15 seconds and whenever the window regains focus,
so later credential rejection or a successful lazy login updates the subtitle.

When the Host reports a missing, expired, or rejected session, or password
login returns positive MFA/CAPTCHA page evidence, the local page automatically
opens the configured region's auth dialog once. Closing it does not reopen the
same requirement revision; only a new state can trigger another automatic open.
The SDK's ambiguous no-ticket text, a password HTTP 401, generic sign-in HTML,
network errors, and MFA-looking titles do not trigger browser authentication.
While unauthenticated, the page polls this coarse data-free state once per
second; after login it returns to the 15-second account refresh.

Configure `GARMIN_USERNAME` and the correct `GARMIN_REGION` before opening the
dialog. `GARMIN_SESSION_TOKEN_FILE` is optional for this Web flow: when omitted,
the Host uses `GARMIN_ACCOUNT` (default `default`) and writes
`~/.config/dsh-plugin-garmin-connect/accounts/<alias>.session.json` on the usual
POSIX configuration path (or the platform configuration root). After a confirmed
write, the running plugin clears any earlier rejected-session state; the next
tool call reads the new file without requiring a dsh restart.

This supported Web flow is intentionally limited to the loopback dsh Web UI. It is not a
remote, hosted, or tunneled login endpoint. Browser third-party-cookie and iframe
policies can prevent Garmin GAuth from completing. A real China-region MFA run
passed the browser, DI exchange, profile confirmation, owner-only persistence,
and read-only session-consumption chain locally on 2026-08-29. A real
International-region MFA run also passed the system-browser challenge, DI
exchange, profile confirmation, and owner-only session persistence.
This does not turn the same-machine flow into a remote or indefinite session-recovery guarantee. Login, MFA, and profile confirmation
must finish within the bridge's 10-minute lifetime.

See the [target architecture for two-step verification](#target-architecture-for-two-step-verification)
for the complete trust boundary and data flow.

#### Local system-browser authentication

The recommended local MFA flow for CLI and MCP clients is the loopback broker.
Choose the account alias and region explicitly. For this command, both flags
are required and `GARMIN_ACCOUNT`/`GARMIN_REGION` are deliberately not used as
defaults, preventing a two-account setup from writing the wrong session:

```bash
# Installed executable
garmin-connect-auth serve --account personal --region global --open
garmin-connect-auth serve --account personal-cn --region cn --open

# Source checkout
npm run auth:serve -- --account personal --region global
npm run auth:serve -- --account personal-cn --region cn
```

`serve` starts a one-shot bridge on a random `127.0.0.1` port and opens it in
the system's default browser. It does not create or manage an isolated
Chrome/Playwright profile; the operating system may reuse an already-running
browser or start the configured default browser. The CLI may read the configured account email, but the
password, MFA code, and any CAPTCHA remain on Garmin's page; they cannot be
supplied through flags, environment variables, MCP tool arguments, or model
input. The bridge receives only the short-lived service ticket and hands it to
the local runtime for the region-bound DI exchange. The page then displays a
sanitized profile for confirmation before the runtime writes the owner-only
session. Login, MFA, and profile confirmation must finish within 10 minutes;
after that, start a new flow.

When `GARMIN_SESSION_TOKEN_FILE` is omitted, the output path is derived from
`GARMIN_ACCOUNT`/`--account`:
`~/.config/dsh-plugin-garmin-connect/accounts/<alias>.session.json` on the usual
POSIX configuration path (or the platform configuration root). The process can
then use only the non-password configuration below:

```dotenv
GARMIN_USERNAME=your-email@example.com
GARMIN_ACCOUNT=personal
GARMIN_REGION=global
GARMIN_FIT_DOWNLOAD_DIR=/absolute/path/to/garmin-fit-parent
```

This browser bootstrap is release-supported for same-machine authentication in
both regions. Real China-region and International-region MFA runs passed locally
on 2026-08-29. Real refresh-token rotation remains part of ongoing compatibility
coverage rather than a limitation on MFA support.

#### Legacy browser diagnostics

`garmin-connect-auth login --browser` is retained only for development and
diagnosis; it is not the recommended fallback for `serve` or MCP authentication.
It launches an isolated Chrome context through Playwright and may encounter
redirect interception failures. The non-persisting canary exercises the same
legacy path:

```bash
garmin-connect-auth login --browser --account personal --region global
garmin-connect-auth login --browser --account personal-cn --region cn
npm run auth:canary -- --region global
npm run auth:canary -- --region cn
```

The direct terminal-password attempt without `--browser` remains for
compatibility. Leaving its password prompt blank opens the shared system-browser
flow; positive MFA/CAPTCHA page evidence switches to that same flow without
asking for a terminal MFA code. Ambiguous password, network, and no-ticket
failures do not auto-open a browser. These diagnostics are separate from the
supported system-browser MFA bootstrap.

DI v2 files bind the normalized username, region, and probed Garmin profile via
one-way hashes, including `profileIdHash`; they do not duplicate the plaintext
email in the binding. The runtime rejects username, region, or profile mismatch
before publishing refreshed credentials. It refreshes access tokens before
expiry, persists a rotated refresh token before using the new session, and may
retry an authentication failure at most once for an idempotent GET. Workout and
other write requests are never replayed automatically.

For backward compatibility, legacy session files containing only the two
`oauth1` and `oauth2` fields are still accepted. They have no profile binding;
the intended replacement is a browser-generated, validated DI v2 session with
the mismatch guard.
On POSIX, a legacy file must still pass the current owner-only file-permission
check (normally mode `0600`), complete safe ancestor-chain validation, and a
private final-parent check (normally mode `0700`).

On POSIX, the default account directory is prepared before Garmin authentication
opens. To choose a different session file, add
`--output /absolute/private/path/personal.session.json`. Preflight canonicalizes
any safe existing link target, rejects unsafe/writable ancestors, requires the
final parent to belong to the effective UID with owner write+execute and no
group/other access (normally mode `0700`), and creates missing components one at
a time as `0700`. The writer uses that canonical destination and rechecks the
parent, existing destination, and no-follow temporary-file handle before the
atomic replacement. On macOS, granting extended ACL entries are rejected on
every checked ancestor, parent, existing file, and empty temporary file; a
private-looking `0700`/`0600` mode does not override that result.
If the normal configuration root or one of its ancestors is group/world-writable,
preflight intentionally refuses to start authentication. Repair that directory's
permissions yourself or set `GARMIN_SESSION_TOKEN_FILE`/`--output` to a fresh
owner-private application directory; the plugin will not silently `chmod` a
shared or broadly writable configuration tree.

On Windows, the implicit account path prefers the current user's local
`LOCALAPPDATA` root over redirected roaming `APPDATA`. Keep any explicit
destination beneath the current user's local OS profile/config root and use a
fresh dedicated subtree; UNC/network destinations are not supported. From the longest matching Windows
special-folder root down to the session parent, every component must have a
protected DACL owned by the current SID with exactly one current-SID
`FullControl` rule. Missing components are created atomically with that DACL;
non-exact existing components and every reparse point are rejected rather than
rewritten. The empty temporary file receives the same exact file DACL before
credential bytes are written, and the entire directory chain plus file ACL is
verified again when a session is read. Marker-only directories from earlier
implementations are not trusted; migrate to a fresh dedicated subtree.

#### Multiple accounts: one isolated process per account

The supported runtime model is one account per process and one independently
initialized session per process. Give each dsh, Codex, Claude Code, or other MCP
process its own `GARMIN_USERNAME`, `GARMIN_REGION`, and `GARMIN_ACCOUNT` (or an
explicit `GARMIN_SESSION_TOKEN_FILE`). Each process can lazily use its implicit
account session path and use the supported browser MFA bootstrap. The real
China-region account chain has been verified end to end.

Do not copy one session file to another process, and do not let simultaneous
processes share one file. Garmin refresh tokens may rotate; concurrent writers
can otherwise invalidate or overwrite each other's credentials. For example,
use aliases such as `personal-dsh`, `personal-codex`, and `personal-claude`, with
an independently initialized session for each one. Do not point another runtime
at the same file through a symbolic link or a differently cased path alias.

The processes may share one `GARMIN_FIT_DOWNLOAD_DIR` parent: the plugin creates
a separate account subdirectory from each configured region and email. This also
keeps `cn` and `global` accounts with the same email from colliding. For one MCP
entry, ordinary Garmin questions use that entry as the default. For two entries,
name them `garmin-cn` and `garmin-global`; mention the server name only when the
intended account is ambiguous.

This is process isolation, not an in-process account selector or a multi-tenant
authorization system. Do not expose one shared MCP process to mutually
untrusted users; per-user access control has not been implemented. Switching
accounts inside one conversation and automatic cross-account sync remain on the
roadmap.

#### FIT downloads

`download_garmin_activity_fit` accepts only an activity ID; the model cannot
choose an arbitrary output path. Garmin's original activity ZIP is downloaded
to a private temporary location, size-checked, and required to contain exactly
one valid FIT file. Given a configured parent directory `<base>`, the result is
written as `<base>/GARMIN_FIT_<cn|global>_<normalized-email>/<activityId>.fit` without
overwriting an existing file. The `cn` or `global` component comes from
`GARMIN_REGION`. Here `<normalized-email>` is derived safely from the configured
email: a normal email address
remains recognizable, while path separators, control characters, and other
unsafe filename characters are normalized before the account directory is
created. The user locates the file from the configured parent plus this rule.
The tool returns only `activityId`, `fileName`, `sizeBytes`, and `sha256`; it does
not return the parent, account directory, email, or full path. ZIP/FIT bytes
never enter model context.

The parent directory has no default and must be chosen explicitly through
`GARMIN_FIT_DOWNLOAD_DIR`. It is required only when using this tool; if unset,
the tool fails before writing any file and all other Garmin tools remain
available. Multiple account processes can safely share the same parent because
their region-and-normalized-email subdirectories are isolated, including when
the same email is used for both Garmin China and Garmin International.
Existing `GARMIN_FIT_<email>` directories are not migrated automatically; new
downloads use the region-prefixed directory while old files remain in place.

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
| Local dsh Web MFA bridge | ✅ Supported; loopback only; real China-region MFA chain passed locally |
| CLI `serve` and MCP URL elicitation | ✅ Supported; same-machine shared runtime and owner-only session persistence |
| Legacy CLI `login --browser` / `canary` | ⚠️ Playwright diagnostics only; not an authentication fallback |
| DI v2 sessions bind username, region, and `profileIdHash`; legacy two-field sessions remain compatible | ✅ |
| Independently initialized per-process session files support isolated multi-account setups | ✅ |
| Access refresh is preemptive; idempotent GET replay is limited to once and writes are never replayed | ✅ |
| Tool outputs never include raw credentials | ✅ |
| FIT bytes and local/account paths stay on the host; the model receives only activity/file name/size/hash | ✅ |
| In-memory cache reduces API calls (rate-limit protection) | ✅ |

### Session Tokens

Session-token authentication remains supported, but tokens are credentials and
must not appear in agent output or trajectory logs. For that reason this plugin
does not expose authentication, MFA submission, or token export as AI-callable
tools. If you already have a validated owner-only DI v2 or compatible legacy
session file, dsh/MCP can read it through `GARMIN_SESSION_TOKEN_FILE`; the
runtime does not need the account password. The DI file binds normalized
username and region as well as `profileIdHash`; legacy unbound
`oauth1`/`oauth2` files remain readable for compatibility. Creating a new MFA
session through the dsh Web bridge, `serve`, or MCP URL elicitation is a
supported same-machine workflow. Because Garmin
refresh tokens may rotate, never concurrently share or copy one session file
across dsh, Codex, Claude Code, or other processes.

---

## Use with Other AI Coding Agents (MCP)

This plugin also ships as a standalone **MCP (Model Context Protocol) server**, so you can use the same Garmin tools with OpenAI Codex, Claude Code, Claude Desktop, Cursor, Windsurf, WorkBuddy, ZCode, and any other MCP-compatible client — no DeepSeek Harness required.

> **Current availability:** the standalone MCP entry point is included in npm
> `0.1.5` and later. A local checkout remains useful for development.

Build the local server first:

```bash
git clone https://github.com/Likenttt/garmin-connect-plugin-for-dsh.git
cd garmin-connect-plugin-for-dsh
npm install
npm run build
```

Replace `/absolute/path/to/garmin-connect-plugin-for-dsh` in the examples with
the checkout's actual absolute path.

The MCP process needs an email, explicit region, and local account alias. A
session-file path is optional: when omitted, the server derives an owner-only
path from `GARMIN_ACCOUNT`. Make these values and any FIT parent directory
available to the client process:

```bash
export GARMIN_USERNAME='your@email.com'
export GARMIN_REGION='global'
export GARMIN_ACCOUNT='personal'
export GARMIN_FIT_DOWNLOAD_DIR='/absolute/path/to/garmin-fit-parent'
# Optional override; otherwise accounts/personal.session.json is used.
# export GARMIN_SESSION_TOKEN_FILE='/absolute/path/to/personal.session.json'
```

Do not put a password or MFA code in these variables. If a tool encounters
a missing, expired, or rejected session, or an explicit MFA/CAPTCHA browser
challenge, and the client advertises MCP URL
elicitation, the tool call returns a random local `127.0.0.1` sign-in URL. Open
that URL, finish Garmin login/MFA and profile confirmation in the browser, wait
for the completion notification, then retry the original request. The server
does not automatically replay it, so a write can never be duplicated by this
flow. Clients without URL elicitation receive the equivalent trusted-terminal
fallback command:

If a legacy `GARMIN_PASSWORD` is still present, successful password-only login
continues to work. Only positive MFA input/form or active CAPTCHA markup is
converted to the same browser-recoverable MCP authentication state. The SDK's
ambiguous no-ticket text, a wrong password, HTTP 401, and network failures are
not treated as MFA; the password and upstream error text never enter the tool
result.

```bash
garmin-connect-auth serve --account personal --region global --open
```

If that MCP entry explicitly sets `GARMIN_SESSION_TOKEN_FILE`, export the same
value in the trusted terminal or append `--output` with that same destination.
The fallback error deliberately does not echo the local path into model
context. After `serve` commits a changed, account-matching session, retrying the
tool hot-loads that exact file snapshot in the already-running MCP process; an
MCP restart is not required. An unchanged rejected file, an expired replacement,
or a file for another account is never probed again. If an inline
`GARMIN_SESSION_TOKEN` was explicitly rejected, this safe replacement also
supersedes it in memory; the rejected inline credential is not retried.

The authentication page, not the MCP tool or model, receives the password and
MFA code. Protect the resulting session file and FIT directory because they can
grant account access or contain precise location and health data. Each
simultaneously running client process needs its own alias/session; do not copy
or concurrently share one file across Codex, Claude Code, dsh, or another
client. Browser MFA is supported as described above; the China-region
real-account chain has been verified end to end.

### OpenAI Codex (app, CLI, and IDE extension)

Codex clients on the same host share `~/.codex/config.toml`. The recommended
setup forwards credential variable names from the environment instead of
copying their values into TOML. With the variables above available to the Codex
process, add this entry to `~/.codex/config.toml`:

```toml
[mcp_servers.garmin-connect]
command = "node"
args = ["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"]
env_vars = ["GARMIN_USERNAME", "GARMIN_REGION", "GARMIN_ACCOUNT", "GARMIN_SESSION_TOKEN_FILE", "GARMIN_FIT_DOWNLOAD_DIR"]

# Read tools can run normally; Codex asks before local-file and Garmin writes.
default_tools_approval_mode = "writes"
```

This entry uses the session assigned only to this Codex process. When Codex
advertises URL elicitation, it may surface the local sign-in link described
above; otherwise initialize the same alias with `garmin-connect-auth serve`.
The password/MFA code stays on Garmin's page. Do not reuse a session already
assigned to dsh, Claude Code, or another running process. For China and
International accounts, add separately configured entries named, for example,
`garmin-cn` and `garmin-global`. They may reuse the same FIT parent; output is
automatically isolated under that account's region-and-normalized-email
subdirectory.

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
  '{"type":"stdio","command":"node","args":["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"],"env":{"GARMIN_USERNAME":"${GARMIN_USERNAME}","GARMIN_REGION":"${GARMIN_REGION:-global}","GARMIN_ACCOUNT":"${GARMIN_ACCOUNT:-default}","GARMIN_SESSION_TOKEN_FILE":"${GARMIN_SESSION_TOKEN_FILE}","GARMIN_FIT_DOWNLOAD_DIR":"${GARMIN_FIT_DOWNLOAD_DIR}"}}'
```

This server uses a session assigned specifically to this Claude Code process.
If the client does not surface MCP URL elicitation, initialize it with the
trusted-terminal `serve` command; password/MFA input remains on Garmin's page.
Register a differently named server and provide a distinct independently
initialized session file for each additional process or account. Do not copy
another process's session. The servers may reuse the same FIT parent directory.

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
        "GARMIN_ACCOUNT": "personal",
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
        "GARMIN_ACCOUNT": "personal",
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

The session file in this entry must be independently initialized; a client that
does not surface URL elicitation uses the trusted-terminal `serve` command.
WorkBuddy and the model never receive the password/MFA code. Add another named
`mcpServers` entry with a separate session file per account. Entries may share
the same FIT parent directory because region-and-email account subdirectories
are automatic.

#### Bundled skill

Starting with version **0.1.7**, the npm package includes
`skills/garmin-connect/`. Copy this complete directory, including `references/`,
to `~/.workbuddy/skills/garmin-connect/`. If the skill is already installed,
update that installed copy as well; upgrading the npm package alone does not
update it. Reload WorkBuddy's skills and MCP service, then start a new session.

The skill can use `create_garmin_workout` on request: preview the workout first,
then create it after the user confirms the preview. To download a requested
activity with `download_garmin_activity_fit`, set `GARMIN_FIT_DOWNLOAD_DIR` to
the absolute path of a trusted local parent directory in the MCP service's
`env`. See the bundled `references/workbuddy-setup.md` for setup details.

### ZCode

Open **Settings → MCP Servers → New MCP Server**, choose **User** scope and
`stdio`, then enter the same absolute Node.js command, `lib/mcp.js` argument,
and Garmin environment variables. Alternatively, edit the native user config
at `~/.zcode/cli/config.json`:

To test this release directly from npm, use an absolute `npx` path
as the command and these arguments instead of a checkout's `lib/mcp.js`:

```text
-y --package dsh-plugin-garmin-connect garmin-connect-mcp
```

Do not configure `GARMIN_PASSWORD`; with a missing session, the first read-only
tool call can exercise ZCode's URL-elicitation path. Keep the explicit
owner-only `GARMIN_SESSION_TOKEN_FILE` shown below.

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
          "GARMIN_ACCOUNT": "personal",
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

The session file in this entry must be independently initialized; a client that
does not surface URL elicitation uses the trusted-terminal `serve` command.
ZCode and the model never receive the password/MFA code. Add another named server with
a separate session file per account. Servers may share the same FIT parent
directory because region-and-email account subdirectories are automatic.

These configurations have been checked against both clients' published schemas;
an end-to-end WorkBuddy/ZCode smoke test with a real Garmin account has not yet
been recorded.

The Claude Desktop, Cursor, Windsurf, WorkBuddy, and ZCode JSON examples store
the sensitive session-file path in their client configuration, but not the
session contents, password, or MFA code. Restrict those files' permissions and
never commit them. The Codex and Claude Code examples forward path variables
instead. MCP results can place sleep, heart-rate, weight, activity, and location
data in the selected model's context; review that client's data controls. Full
activity detail is the default and may include precise route/location data;
choose `compact` per call or through `GARMIN_ACTIVITY_DETAIL` for smaller output.
FIT bytes and the complete local/account path remain on the MCP host. Only the
activity ID, file name, size, and hash enter model context; locate the file
using your configured parent and the documented account-directory rule.

With npm `0.1.5` or later, the local `node …/lib/mcp.js` command can be replaced
with:

```bash
npx -y --package dsh-plugin-garmin-connect garmin-connect-mcp
```

### Manual Run

```bash
# Run the MCP server (stdio); the account session path is derived lazily.
GARMIN_USERNAME=xxx \
GARMIN_ACCOUNT=personal \
GARMIN_REGION=global \
GARMIN_FIT_DOWNLOAD_DIR=/absolute/path/to/garmin-fit-parent \
node lib/mcp.js
```

The MCP server exposes the same **10 tools and argument semantics** as the dsh
plugin: activities, sleep, steps, heart rate, weight, workout-library templates,
profile, running skills, local FIT download, and workout preview/creation.
No AI-callable tool accepts a password/MFA code or exports a session token.
Browser authentication is an out-of-band local URL elicitation, and the user
must retry the original tool after completion.

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

### Target architecture for two-step verification

The architecture gives dsh Web, MCP clients, and the CLI one shared local
authentication runtime while keeping Garmin credentials out of AI conversations:

```text
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ dsh Web          │  │ MCP tool call    │  │ CLI serve        │
│ region/auth state│  │ URL elicitation  │  │ system browser   │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         └─────────────────────┼─────────────────────┘
                               ▼
          LocalAuthBroker + EmbeddedAuthController
                               │
                               ▼
          random one-shot 127.0.0.1 bridge
          flowId + CSRF + strict CSP + 10-minute TTL
                               │ embeds the exact regional page
                               ▼
          official Garmin GAuth iframe (cn / global)
          email, password, MFA, and CAPTCHA stay here
                               │
                               │ one-time ticket + original exact service
                               ▼
          Host validates origin / iframe / CSRF / ticket / service
                               │
                               ▼
          regional DI exchange → profile probe → user confirmation
                               │
                               ▼
          atomically persist an owner-only DI v2 session
          bound to account, region, and profile; never shared by processes
                               │
                               ▼
          GarminClient hot-load / safe refresh
                               │
                               ▼
          user explicitly retries the original tool call
```

The non-negotiable boundaries are:

- The outer dsh page, MCP client, and model see only a one-time local URL,
  completion notification, or coarse non-sensitive status. Tickets, DI tokens,
  session contents, and session paths never enter model context or AI tool
  arguments/results.
- The bridge accepts only the expected Garmin SSO origin, iframe window, CSRF,
  and an exactly matched `ticket/service` pair. It never rewrites the service,
  follows a redirect, or retries a one-time ticket against a fallback.
- Before saving a session, the Host probes the Garmin profile and asks the user
  to confirm the account. It then writes the session atomically with private
  permissions. A running client hot-loads only a changed, account-matching,
  validated session.
- Authentication never replays the original tool automatically, preventing
  duplicate FIT downloads or workout writes. Failure, cancellation, or timeout
  ends the flow; another attempt creates a new flow.
- Refresh may replay a safe GET at most once. It first verifies the same profile
  and persists rotated tokens; writes are never replayed after refresh.

> [!NOTE]
> This is the target architecture and the boundary followed by the current
> release-supported implementation. A real China-region MFA → exact ticket/service
> → DI exchange → profile confirmation → private session write → fresh-client
> read chain has passed locally. A real International-region MFA → DI exchange
> → profile confirmation → private session write also passed. Real refresh-token
> rotation and complete URL-elicitation UX in more MCP clients remain ongoing
> compatibility coverage.
> The design is same-machine loopback only, not a remote, multi-user, or hosted
> authentication service.

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
├── account-session.ts # Implicit per-account session destination
├── auth.ts           # Private-SSO authentication flow with local MFA callback
├── auth-cli.ts       # Trusted local serve and legacy diagnostic commands
├── browser-auth-canary.ts # Isolated Chrome DI setup/canary core
├── embedded-auth-runtime.ts # Shared Web/CLI/MCP ticket-to-session runtime
├── local-auth-broker.ts # One-shot loopback/system-browser broker
├── di-session.ts     # DI runtime validation, refresh, and safe GET replay
├── session-store.ts  # Strict session-file loading and atomic private writes
├── darwin-private-acl.ts # Darwin extended-ACL verification
├── windows-private-acl.ts # Owner-only Windows SID/DACL enforcement
├── fit-export.ts     # Bounded, non-overwriting FIT extraction from original ZIP
├── tool-service.ts   # Shared tool behavior for dsh and MCP
├── mcp.ts            # Standalone MCP adapter for Codex/Claude Code/other clients
├── mcp-auth.ts       # URL elicitation, completion notification, and fallback
├── mcp-shutdown.ts   # Bounded stdio/signal cleanup for MCP auth
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
- [x] **Browser MFA Bootstrap** — supported for China and International accounts through local dsh Web, system-browser `serve`, and MCP URL elicitation; real MFA passed in both regions, with broader compatibility testing continuing
- [x] **Process-isolated Accounts** — one independently initialized session file per dsh/MCP process; concurrent file sharing is unsupported
- [x] **FIT Download** — safely extract one FIT from the original archive into an automatic region-and-normalized-email subdirectory under a user-selected parent
- [ ] **Training Status** — VO2 Max, training load, recovery time
- [ ] **Single-process Account Registry** — run an isolated client, cache, limiter, and bound session for every configured account alias
  - [ ] `list_garmin_accounts` — list aliases, regions, and connection status without exposing email addresses, tokens, or session paths
  - [ ] Add an optional `account` argument to account-sensitive tools; require an explicit alias when no safe selection exists
  - [ ] `use_garmin_account` — select an account for one conversation when dsh exposes a trusted conversation identity
  - [ ] Fall back to passing the selected alias on every tool call; never use a process-global active account
  - [ ] Add per-user account allowlists before describing the feature as multi-tenant isolation
- [ ] **Multi-account Activity Sync** — copy activities in one explicit direction between CN and Global accounts
  - [ ] Preview the source, target, date range, candidates, duplicates, and privacy impact before any upload
  - [ ] Bind a short-lived, one-time confirmation to the exact account pair and immutable activity manifest
  - [ ] Stage and validate FIT privately, then upload once to the explicitly selected target; never delete the source
  - [ ] Persist a sync ledger for exact deduplication, restart recovery, and unknown upload outcomes; never blindly retry a timed-out POST
  - [ ] Add bounded batch jobs with `status`, `pause`, and `resume`
  - [ ] Add opt-in polling schedules for one-way automatic sync while dsh is running, with catch-up after restart
  - [ ] Keep bidirectional sync, automatic deletion, and full Garmin metadata mirroring out of the first release
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
- Thanks to Zhitao and [DailySync](https://dailysync.cn) for the inspiration

<sub>Product names and logos belong to their respective owners and are shown only to describe interoperability.</sub>
