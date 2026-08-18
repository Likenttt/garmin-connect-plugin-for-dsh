# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Stale-while-revalidate (SWR) cache mechanism with LRU size bounds.
- Retry logic with exponential backoff on rate-limits (429) and auto-reconnect on session expiry (401/403).
- Support for date range queries in sleep, steps, and heart rate tools.
- More comprehensive formatters extracting elevation, cadence, and active minutes.
- Unit tests for cache, formatters, and tool utilities.
- GitHub Actions CI/CD workflow.

### Changed
- Improved error handling for all AI-callable tools. Errors are now returned gracefully to the agent.
- Prompts added to tool descriptions to improve LLM invocation accuracy.
- Upgraded `cordis` dependency version and configuration schemas.
- Modified `.env.example` to clarify session token usage.

## [0.1.0] - Initial Release

- Initial setup with basic Garmin Connect integration.
- Read activities, sleep, steps, heart rate, and profile.
- Export session token.
