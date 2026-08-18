# Changelog

All notable changes to this project will be documented in this file.

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
