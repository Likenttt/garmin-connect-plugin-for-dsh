# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

> This section compares the current checkout with the npm-published `0.1.4`
> package. The package version has not been changed or published. Browser-based
> Garmin two-step verification remains unfinished and is not release-supported.

### Added
- A standalone `garmin-connect-mcp` server exposing the same 10 Garmin tools as the dsh plugin to Codex, Claude Code/Desktop, Cursor, Windsurf, WorkBuddy, ZCode, and other stdio MCP clients.
- `create_garmin_workout` for running, cycling, swimming, and strength workouts, including structured repeats and pace or heart-rate targets.
- Workout writes now use a preview plus a one-time, definition-bound `confirmationId`; Garmin is changed only when the caller returns the exact ID with `confirmed: true`.
- `download_garmin_activity_fit` safely extracts one validated FIT file from Garmin's original activity archive into a user-selected local parent without overwriting an existing file.
- FIT files are isolated under `<base>/GARMIN_FIT_<cn|global>_<normalized-email>/<activityId>.fit`; tool results expose only activity ID, file name, size, and SHA-256.
- Four evidence-labelled running philosophies: Hansons, Jack Daniels, Norwegian controlled threshold/double-threshold, and polarized training.
- Personalized running coaching with a six-part intake covering goals, current performance, training history, availability, health/recovery, and preferred training-load style.
- `garmin-connect-auth` for trusted local terminal setup, plus `GARMIN_SESSION_TOKEN_FILE` for loading an existing validated session from an owner-only, account-bound file.
- Runtime support for valid DI v2 session files, including profile/account verification, early access-token refresh, atomic token writeback, and one replay for idempotent reads only. Legacy OAuth files remain readable.
- Process-isolated multi-account setups: each dsh or MCP process can use its own account, region, cache, client, and separately initialized session file.

### Changed
- Running advice now has explicit `explain` and `personalized` modes. Personalized intensity is based on current performance, and double-threshold training is never the default.
- Missing coaching intake answers produce focused questions instead of a plan or Garmin fetch. Warning symptoms stop hard-training recommendations.
- `get_garmin_workouts` is documented as the Garmin workout library, not calendar scheduling.
- The dsh and MCP adapters now share one service layer, so tool behavior, validation, confirmation, and error handling stay aligned.
- FIT directories now include `GARMIN_REGION`. For earlier local preview checkouts, existing `GARMIN_FIT_<email>` directories remain in place and are not migrated automatically.
- Codex, Claude Code/Desktop, Cursor, Windsurf, WorkBuddy, and ZCode setup instructions now cover local checkout, environment forwarding, and connection checks.
- Integration-test output is private by default, supports password or legacy session authentication, aggregates failures, and returns a non-zero status when checks fail.
- The workout maintenance script is dry-run by default and skips names already present in the Garmin workout library.

### Breaking changes since 0.1.4
- The minimum supported Node.js version is now 20 instead of 18.
- `get_running_skill_advice` now requires `mode` (`explain` or `personalized`) and returns the selected language instead of the previous always-bilingual response.
- Direct TypeScript consumers of `Config` must provide `fitDownloadDir`; an empty string keeps FIT download disabled.
- This set of changes is not a drop-in patch for every `0.1.4` consumer. Restore compatibility before publishing as `0.1.5`, or use a minor-version release boundary.

### Removed — breaking
- Removed the AI-callable `export_garmin_session` tool. Authentication material must now be handled through trusted local configuration and files.

### Fixed
- Adapted step and body-composition formatting to the actual `garmin-connect` response shapes.
- Preserved local calendar dates and consistently honored the configured China or International region.
- Added bounded request deadlines, account-wide date-query concurrency, blocking cache refresh, and status-preserving retries for idempotent reads.
- Aligned recursive workout validation, repeat ordering, child IDs, and swimming/strength sport IDs with Garmin payloads.
- Step goals and walking distance remain `null` when the installed Garmin client only returns a numeric step total, instead of reporting misleading zeroes.

### Security
- Removed AI-callable session-token export; session credentials are handled only through trusted local workflows.
- Passwords, MFA codes, OAuth data, FIT bytes, email-derived directories, and absolute local paths stay out of tool results and model context.
- Session files use strict parsing and atomic owner-only writes. FIT extraction is bounded, validates ZIP and FIT integrity, and never overwrites an existing output.
- Per-client refresh handling replaces the upstream global interceptor. Idempotent reads may replay once after authentication refresh; workout writes never replay automatically.
- Cached and in-flight data are isolated across identity changes, and expanded activity output filters credential, account, and unrelated social fields.
- Logs and integration tests hide raw Garmin responses, account identifiers, and health/activity details unless verbose integration output is explicitly enabled.

### Development and packaging
- The MCP SDK and Zod are required runtime dependencies; tested versions of the MCP SDK, TypeScript tooling, and `tsx` are pinned.
- `prepare` uses the local TypeScript compiler. CI adds finite timeouts, coverage thresholds, and package dry-run smoke tests.
- Published package contents now include `.env.example` and bilingual test reports.

### Experimental — not release-supported
- Browser `garmin-connect-auth login --browser` and `garmin-connect-auth canary` remain developer diagnostics. Garmin two-step verification is unfinished and must not be presented as a supported next-release capability.
- DI runtime loading is implemented for valid DI v2 files, but browser-generated persistence followed by dsh/MCP restart and refresh, and the International-region flow, are not verified end to end.

### Known limitations
- Every concurrent Codex, Claude Code, dsh, or other client process needs its own session file. Do not copy, share, symlink, or address one file through differently cased aliases.
- Multi-account support is process-isolated only. Switching accounts inside one conversation, cross-account activity sync, and multi-tenant authorization remain roadmap work.
- Garmin's original activity archive may contain no FIT or multiple FIT files. The download tool fails safely unless exactly one valid FIT is available.

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
