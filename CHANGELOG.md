# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

> These changes are not included in the published npm `0.1.4` package. The
> package version remains unchanged and this checkout is not ready for a stable
> release until the private MFA flow is verified with real accounts.

### Added
- Shared tool-service behavior for the dsh plugin and standalone MCP server, so both interfaces expose the same 10 tools and argument semantics.
- Experimental local `auth:setup` flow for Garmin two-step verification: password and MFA code are entered with echo disabled in a trusted local TTY, never through CLI flags, environment variables, MCP tools, or model input; only a private OAuth session file is persisted (`0600` on POSIX; Windows ACL validation remains a limitation).
- `GARMIN_SESSION_TOKEN_FILE` runtime authentication, allowing dsh/MCP to restart without storing the Garmin password.
- Account-bound session files: new auth CLI output stores a one-way SHA-256 digest of the trimmed, NFKC-normalized, lower-cased username plus region and rejects mismatched runtime configuration before loading OAuth tokens. Legacy files with only `oauth1` and `oauth2` remain readable for compatibility.
- Process-isolated multi-account operation: generate one session file per account and run a separate dsh profile or MCP server/process for each account.
- `download_garmin_activity_fit`, which requires an explicitly chosen `GARMIN_FIT_DOWNLOAD_DIR` parent (no default), downloads Garmin's original activity ZIP, and safely extracts exactly one bounded/validated FIT as `<base>/GARMIN_FIT_<user-email>/<activityId>.fit`. The email component is safely normalized: normal emails remain recognizable while unsafe filename characters are replaced. Multiple account processes may share the parent. The tool refuses overwrite, returns only activity ID/file name/size/hash (never the parent, account directory, email, full path, or binary data), and fails before writing if the parent is unset.
- Explicit workout preview/confirmation flow: writes require `confirmed: true` plus a matching, one-time `confirmationId` issued for the unchanged preview.
- Read-only integration-test authentication via either password or `GARMIN_SESSION_TOKEN`; failures are accumulated and produce a non-zero exit status.
- Conservative coverage checks, a package dry-run smoke test, and a finite CI timeout.

### Changed
- Moved the MCP SDK and Zod from optional to required runtime dependencies; pinned the tested MCP SDK and local `tsx` versions.
- Raised the supported Node.js baseline to 20 to match the MCP runtime dependency tree.
- Changed `prepare` to use the project's local TypeScript compiler instead of downloading one through `npx`.
- Package contents now include `.env.example`.
- Corrected workout-listing terminology: `get_garmin_workouts` returns workout-library templates, not calendar scheduling.
- Added verified Codex and Claude Code setup, connection checks, environment-based credential forwarding, and natural-language usage examples.
- Documented that npm `0.1.4` predates the MCP entry point and uses a local checkout until an MCP-capable version is published.
- Documented session-file/MFA setup for Codex, Claude Code, WorkBuddy, and ZCode, including one isolated server per Garmin account.
- Made the standalone workout maintenance script dry-run by default and skip already-existing workout names.

### Fixed
- Adapted step and body-composition formatting to the real `garmin-connect` response shapes.
- Preserved local calendar dates when querying Garmin and honored the configured global/China region.
- Added bounded request deadlines, account-wide date-query concurrency, blocking cache refreshes, and status-preserving retries for idempotent reads.
- Strengthened recursive workout validation and aligned repeat ordering, child IDs, and swimming/strength sport IDs with Garmin workout payloads.
- Kept step goals and walking distance nullable when the installed Garmin client only returns a numeric step total.

### Security
- Removed AI-callable session-token export and documented that session tokens must be handled as secrets through trusted local workflows.
- Kept password, MFA codes, OAuth session contents, ZIP/FIT bytes, email-derived directories, and complete local paths out of model context; the FIT tool accepts no caller-controlled output path.
- Added strict session-file parsing plus atomic owner-only writes, and bounded/non-overwriting FIT extraction with archive/header validation.
- Required an existing custom `auth:setup --output` parent to be owner-only on POSIX (normally `0700`); missing parents are created owner-only and unsafe parents are rejected.
- Redacted sensitive authentication details from logged errors.
- Replaced the upstream SDK's global refresh interceptor with per-client, quiet refresh handling; non-idempotent workout writes are never replayed automatically.
- Isolated cached/in-flight data across session-token to password identity changes and filtered credential/account/social fields from expanded activity output.
- Added one-time, expiring, definition-bound workout confirmation IDs and marked MCP write/read semantics with tool annotations.
- Prevented the upstream Garmin SDK from logging raw HTTP response bodies.
- Made integration-test output hide account identifiers and health/activity details by default; detailed output now requires `GARMIN_INTEGRATION_VERBOSE=true`.

### Known limitations
- The MFA implementation uses Garmin's private SSO flow and has not yet completed an end-to-end test with a real MFA-enabled global or China account.
- Multiple accounts are isolated by separate processes; a single-process account selector and multi-tenant authorization/ACL are not implemented.
- Garmin's original activity archive is not guaranteed to contain a FIT file; FIT download fails safely when there is no single valid FIT entry.

## [0.1.4] - 2026-08-19

### Added
- New `get_running_skill_advice` tool backed by a bilingual (Chinese/English) knowledge base of 8 core running training skills (Easy Run, Marathon Pace, Lactate Threshold, VO₂max Intervals, Strides & Repetitions, Fartlek, Hill Repeats, Marathon-Specific Endurance). Each skill includes heart-rate zones, how to practice, common mistakes, and keyword matching; optionally cross-references the user's recent Garmin running activities.
- Unit tests for the running skills knowledge base (data integrity, keyword lookup, card formatting).

## [0.1.3] - 2026-08-19

### Added
- "More Apps" section at the top of both READMEs linking to the GameraSnap app family (GameraSnap, WristAlbum, WristTale, WristPass, 2FA4G, JiaKe.app).

### Changed
- README app icons constrained to a compact 32px size.

## [0.1.2] - 2026-08-19

### Changed
- `formatActivity` now supports a `compact` / `full` detail switch: `compact` (default) returns the curated subset to save context tokens, while `full` returns every raw Garmin field with normalized convenience fields (pace, speeds, durations, heart rate, cadence, elevation) layered on top.
- `get_garmin_activities` accepts a per-call `detail` argument (`compact` | `full`), defaulting to the new `GARMIN_ACTIVITY_DETAIL` config (`compact`).

## [0.1.1] - 2026-08-19

### Added
- Stale-while-revalidate (SWR) cache mechanism with LRU size bounds.
- Retry logic with exponential backoff on rate-limits (429) and auto-reconnect on session expiry (401/403).
- Support for date range queries in sleep, steps, and heart rate tools.
- More comprehensive formatters extracting elevation, cadence, and active minutes.
- Unit tests for cache, formatters, and tool utilities.
- GitHub Actions CI/CD workflow.

### Fixed
- dsh compatibility: plugins now inject the `tools` service (dsh's tool registry) instead of the nonexistent `dshTools` service.
- Tool definitions now follow the dsh registry contract (JSON Schema `parameters` + `output { schema, render }`), so all 8 tools register correctly.
- Runtime imports moved to `@deepseek-ai/cordis` (the Cordis fork dsh runs on) and the config schema now uses `@deepseek-ai/schemastery`; the package is installable from the npm registry without a stray `cordis` peer dependency.
- Garmin login no longer depends on a `ready` lifecycle event (dsh's Cordis fork does not emit one). The client now connects lazily on first tool use and eagerly warms up in the background at activation, with a shared in-flight promise to avoid duplicate logins.

### Changed
- `dsh.bundle` manifest converted to the standard `{ patch: "./cordis.patch.yml" }` format with a checked-in `cordis.patch.yml`.
- `prepare` script is self-contained (pinned TypeScript via `npx`) so GitHub source installs can build.
- Improved error handling for all AI-callable tools. Errors are now returned gracefully to the agent.
- Prompts added to tool descriptions to improve LLM invocation accuracy.
- Modified `.env.example` to clarify session token usage.

## [0.1.0] - Initial Release

- Initial setup with basic Garmin Connect integration.
- Read activities, sleep, steps, heart rate, and profile.
- Export session token.
