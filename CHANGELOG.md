# Changelog

All notable changes to this project will be documented in this file.

## [0.1.19-dev.0] - Unreleased

### Added
- Add an official Personal API Key provider to DSH account settings and standalone MCP, without requiring an email. Keep up to five independently named accounts, private credential slots, and an explicit connection check.
- Integrate a pinned, attributed source snapshot of [connect-personal-api-ts](https://github.com/Likenttt/connect-personal-api-ts). Route `global` and `cn` credentials to their configured regional endpoints without cross-region fallback.
- Advertise 15 supported tools for Personal-only connections. Preserve original read responses, label respiration and stress summaries, and keep unsupported training writes unavailable.
- Add the illustrated Chinese Personal API guide and a standalone responsive HTML preview.

### Verification
- The independent SDK passes 24 offline tests, including credential-rotation races. Plugin configuration, account isolation, RPC validation, provider routing and tool filtering have focused regression coverage.
- A real mainland Key with `region: cn` reached the `.cn` token exchange but returned HTTP 526. The real MCP process exposed the 15 expected tools and relayed the failure without attempting another authentication provider. Successful authenticated mainland data access remains unverified.
- A separate international Key with `region: global` passed token exchange and eight SDK reads, plus five real MCP tool reads. A concurrent mainland-Key check still returned HTTP 526. See the regional endpoint test report.
- This development version and SDK have not been published to npm.

## [0.1.18] - 2026-10-22

### Added
- Add daily blood oxygen (`get_garmin_spo2`) and respiration (`get_garmin_respiration`) read-only tools to DSH and MCP through the maintained SDK's authenticated HTTP transport. Preserve complete responses, including available descriptors and time series; missing fields and empty responses are not converted to zero. The plugin now registers 28 tools, including 24 queries or local knowledge tools.
- Extend the bundled Garmin skill with tool discovery, single-date examples and data-availability guidance for blood oxygen and respiration.

### Changed
- Expand the bilingual WristTale description to cover Garmin, Apple and Android watches, with each platform linking to its corresponding localized page on wristtale.com.

### Verification
- Host/client compilation, browser bundling, the maintained SDK dependency gate and 155 focused tests across six suites passed. The new tools use the authenticated transport already available in the published `@likenttt/garmin-connect@1.7.0`; no unpublished SDK methods are required.
- On 2026-10-21, existing China and International sessions passed six DSH tool reads and six MCP parity checks. Both regional endpoints returned HTTP 200. The International account returned two blood oxygen hourly summaries, 676 respiration time-series entries and 24 respiration summaries for the tested date. The China account's measurement fields were `null`, so this check confirms access rather than regional measurement availability.
- The local `0.1.18-dev.20261021.1` candidate was installed and tested in a real Harness desktop conversation: all four blood oxygen/respiration calls succeeded across the two accounts. These checks cover the candidate, not an installation of the final 0.1.18 package. See the [verification record](docs/testing/spo2-respiration-session-2026-10-21.md).

## [0.1.17] - 2026-10-19

### Added
- Add workout management tools shared by MCP and DSH: list scheduled workouts, preview and confirm deletion of a workout-library template, and separately cancel one calendar entry while retaining its template. Use fresh target details and account-bound, expiring, one-use confirmations; writes are not automatically replayed.
- Add bilingual product introductions crediting 李二牛 and explaining the recommended Garmin browser login, local session storage and data sent to the chosen AI client.
- Send concise MCP server instructions during connection initialization: discover actual tool schemas, verify the selected account for data queries, choose explicit dates and relevant tools, and verify capabilities again after an authorized update and reconnect. Initialization itself performs no Garmin requests or writes.
- Keep unavailable tools, successful empty responses and authentication/HTTP failures distinct in the MCP execution guidance.

### Verification
- Host/client compilation, browser bundling and the maintained SDK gate passed. Release preparation verified 66 targeted tests: 57 new transport, service and MCP/DSH adapter cases, five existing tool-discovery and MCP-instruction cases, and four Harness compatibility cases. These focused results are separate from historical full-suite runs.
- On 2026-10-18, the development candidate passed a real DeepSeek Harness `0.2.1-rc.2` check with the China main account. Cancelling the dedicated test calendar entry retained its template; deleting that template removed it from the library and returned HTTP 404 on detail readback. The original 42 workout IDs were unchanged and test data was cleaned up. This live check covers one China account, one template and one calendar entry; see the [verification record](docs/testing/workout-management-harness-2026-10-18.md).

## [0.1.16] - 2026-10-17

### Fixed
- Support DeepSeek Harness `0.2.1-rc.2` and subsequent release candidates in the `0.2.1` version line with the bounded peer range `>=0.2.1-rc.1 <0.2.2-0`. Preserve the previously supported versions and exclude the next version line, including its prereleases.
- Build against the matching `0.2.1-rc.2` client SDKs. The connection, settings and layout interfaces used by the plugin remain compatible.
- Add a focused regression matrix using the Host's `includePrerelease: true` semantics and matching semver version, covering accepted release candidates and rejected version boundaries.

## [0.1.15] - 2026-10-17

### Fixed
- Declare compatibility with DeepSeek Harness `0.2.1-rc.1` client packages and build against its matching client interfaces. Retain the earlier supported Harness versions.
- Follow the 0.1.14 recovery API release with a compatibility update after the local desktop automatically upgraded during restart.

### Verification
- Host compilation, client type compilation, browser bundling and the maintained SDK gate passed against the matching `0.2.1-rc.1` interfaces.
- Of 32 targeted script/dependency checks, 31 passed on the initial run. The settings-client case exceeded the unchanged five-second limit while the release build was running; its isolated rerun passed in 1,067 ms under the same limit. No runtime or test logic changed.

## [0.1.14] - 2026-10-17

### Added
- Integrate recovery APIs into the bundled Garmin skill and a focused HRV/recovery reference: discover actual tool schemas, choose summaries or daily detail by task, handle account/date/device differences and missing data, and document skill/MCP reloads. Extend DSH/MCP coaching instructions with the same optional data selection while preserving intake and avoiding automatic recovery queries.
- Add 13 recovery and training tools to both DSH and MCP, bringing the total to 23: daily HRV and summaries, daily stress and summaries, Body Battery, training readiness, daily and aggregated training status, training load balance, daily and range max metrics, and latest and range race predictions. These correspond directly to the maintained SDK's 13 new methods.
- Support explicit calendar dates, native inclusive date ranges, and daily/monthly race prediction history with a maximum 366-day calendar span. Preserve complete response fields, all returned devices and time series, unknown fields, and normal `null`/empty-array results.
- Reuse existing account selection, session refresh, cache, timeout, retry, and authentication-change isolation for the new tools. DSH uses stable account IDs; standalone MCP uses its configured process account.
- Add `scripts/check-health-release.cjs` for read-only checks against existing private DI session files, covering DSH execution, all 23 MCP registrations, new-tool response parity/cache reuse, and profile/activity/sleep regressions. Its private account manifest and report use mode `0600`; raw health data and credentials are not printed.
- Add `npm run check:sdk` and 28 release-gate unit cases. The gate checks the maintained dependency source and exact scoped npm alias, verifies the installed SDK's package/repository identity and all 13 methods, rejects stale Git lock entries behind an npm alias, checks the exact official registry tarball URL, and runs after the build in `prepublishOnly` and `pack:smoke`.

### Changed
- Replace the upstream SDK dependency with the published `@likenttt/garmin-connect@1.7.0` from [Likenttt/garmin-connect](https://github.com/Likenttt/garmin-connect). Use the exact `npm:@likenttt/garmin-connect@1.7.0` alias in the manifest and official registry tarball/integrity in the lockfile, retaining `garmin-connect` imports.
- Publish the standalone maintained SDK to the official npm registry on 2026-10-17. Its precompiled package removes Git dependency preparation and Git subdependency requirements. The previous Git candidate encountered pnpm 11 policy errors; those policies remain enabled, and the registry-backed local candidate has now passed formal desktop CLI installation.

### Verification
- The 0.1.14 release build and maintained-SDK dependency gate passed. A fresh full run was interrupted after 25 file-I/O timeout failures during severe local memory pressure; it is not recorded as a 1,000-case pass. A timed-out session-restore case passed on Harness Node 24.18.1 under the unchanged five-second limit (1,485 ms). Earlier full and targeted results below remain separate evidence.
- On 2026-10-16, clean npm source installation passed all 42 suites and 992/992 plugin tests, including 95 new development tests, plus 59/59 maintained SDK tests and the SDK's strict public-type check. Clean `npm ci`, build and `check:sdk` also passed with SSH disabled. These development checks are separate from historical release reports and do not assert a fresh browser login or a completed official desktop installation.
- The earlier desktop installation rejected the Git dependency with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`, then `ERR_PNPM_EXOTIC_SUBDEP` after allowing preparation for the exact commit. The policies remain enabled; the earlier development overlay has since been replaced by the official CLI installation described below.
- The registry-alias candidate passed host/client builds, `check:sdk`, and all 42 suites / 992 plugin tests. After eight further lockfile guard cases were added, the targeted release-gate suite passed 28/28. The checkout now has 1,000 cases; these results are the 992-case full run plus eight additional targeted cases, not a single 1,000-case full run.
- The standalone scoped SDK is published on official npm. Before 0.1.14, a local `0.1.13` development candidate passed official desktop CLI installation using `--ignore-scripts` and the official registry. Its SDK name/version, all 13 methods, official lockfile integrity and all 60 published `dist` files match; the development marker is removed. pnpm added only the exact SDK version to `minimumReleaseAgeExclude`, leaving other policies unchanged. Harness 0.2.0-rc.2 restarted successfully with the Garmin component running and two main accounts signed in. The 26 previously successful API calls were not repeated against the identical SDK build, and no model conversation was sent. Version 0.1.14 packages these features and the bundled recovery skill reference. See the [integration verification report](docs/testing/health-release-readiness-2026-10-16.md) for the historical checks and coverage.

## [0.1.13] - 2026-10-05

### Fixed
- Declare compatibility with DeepSeek Harness `0.2.0-rc.2` client packages and build against its client interfaces. Keep the earlier supported Harness versions available.

## [0.1.12] - 2026-09-30

### Fixed
- Declare compatibility with DeepSeek Harness `0.2.0-rc.1` client packages. Remove the `dsh-client-runtime` peer and client injection because Harness 0.2 no longer provides that package; keep the earlier client version ranges for older Harness installations.
- Keep embedded Garmin authentication on local DSH clients by checking the Host request's physical loopback address before its authenticated Fetch routes run. Update the settings mirror initialization to the `ensure()` API shared by both supported Harness generations.

## [0.1.11] - 2026-09-29

### Added
- Add a Garmin account list in local Harness plugin details. Installation needs no email; users can add up to five accounts with the + button, assign each a China or International region and optional display alias, and keep sessions separate even when accounts share a region. Login starts from the chosen account in settings and stays embedded in Harness. Standalone CLI/MCP clients continue opening the system browser.
- Add stable account IDs and explicit account selection to Garmin tools when multiple accounts are configured, preventing reads and writes from silently targeting the wrong account.

### Fixed
- Remove the top-right account buttons and direct missing-account errors to the settings form. Preserve existing single-account and regional account settings when upgrading.
- Show a masked saved email in each editable account field while keeping the complete address on the Host. Replacing an address saves the new value and starts a fresh Garmin sign-in.
- Keep the region, alias, and email inputs aligned when field labels wrap in the Harness settings form.
- Clarify the separate Harness and CLI/MCP setup paths in the bilingual guides and environment template. Document publication to the official npm registry explicitly.

## [0.1.10] - 2026-09-27

### Fixed
- Allow the local Garmin login bridge to be embedded by the current DeepSeek Harness `dsh-app://app` page. The bridge keeps its existing loopback frame ancestors and exact origin checks.

## [0.1.9] - 2026-09-27

### Fixed
- Restore the local DeepSeek Harness Garmin login buttons on newer Hosts by registering the four authentication endpoints on the Host's guarded `/api` fetch routes. The client retains a 404-only fallback to the older `/garmin-auth` RPC channel, so browser-based MFA also remains available on older Hosts.

## [0.1.8] - 2026-09-26

### Changed
- `get_garmin_activities` now defaults to `full` in both the DeepSeek Harness plugin and standalone MCP server. The formatter also defaults to `full`, preserving the expanded fields Garmin supplies in the activity list, including split summaries when present.
- `compact` remains available through the per-call `detail` argument or `GARMIN_ACTIVITY_DETAIL=compact`. Full responses may contain precise route and location data; credential and unrelated account/social fields remain filtered.

## [0.1.7] - 2026-09-09

### Added
- Ship the WorkBuddy `garmin-connect` skill and its setup reference in the npm package.
- Document the optional `GARMIN_FIT_DOWNLOAD_DIR` setting and how to update the installed WorkBuddy skill.

### Changed
- Allow the WorkBuddy skill to create Garmin workouts and download activity FIT files when explicitly requested, instead of refusing all writes.
- Retain the existing workout preview and one-time confirmation flow, explicit FIT destination, no-overwrite behavior, and manual retry after authentication or uncertain write results.

## [0.1.6] - 2026-08-30

### Changed
- Promoted browser-based MFA from preview to a supported capability for both China and International Garmin accounts across local dsh Web, the system-browser `garmin-connect-auth serve` flow, and MCP URL elicitation.
- Repositioned the package as a Garmin Connect plugin and MCP server for mainstream AI agents instead of a DeepSeek Harness-only plugin.
- Increased the bounded cold-start allowance for the Windows PowerShell 5.1 ACL helper from 30 to 60 seconds.

### Verified
- A real China-region account passed the complete browser MFA, exact ticket/service, DI exchange, profile confirmation, owner-only session persistence, fresh-client profile probe, and recent-activity read chain.
- A real International-region account passed system-browser MFA, global DI exchange, profile confirmation, and owner-only `0600` session persistence. The saved session passed private-file validation and matched the configured normalized account and region without exposing credentials in logs or model context.

## [0.1.6-rc.1] - 2026-08-29

### Added
- Added an experimental Garmin sign-in entry to the local dsh Web UI. It opens a custom bridge on an ephemeral `127.0.0.1` port and embeds Garmin's official GAuth page inside that bridge.
- After the bridge receives one valid region-bound service ticket, the plugin Host immediately exchanges it for DI credentials, probes a sanitized Garmin profile for user confirmation, and atomically saves an owner-only session bound to the configured account and region.
- When no session path is configured, the local Web flow derives one from `GARMIN_ACCOUNT`; after a confirmed write, the running Garmin client forgets any earlier rejected session and can load the new file on its next tool call without a restart.
- Added `garmin-connect-auth serve --account <alias> --region <global|cn> --open`, which reuses the shared loopback bridge in the system default browser without Playwright or a separate Chrome profile.
- Standalone MCP now supports URL elicitation for typed missing, expired, or rejected Garmin credentials. Concurrent requests share one local flow; completion is notified to the client, which must explicitly retry the original tool.
- The local dsh Web client now opens the configured region's browser flow once when the Host reports a new typed missing/expired/rejected session or a positively identified MFA/CAPTCHA challenge. Dismissing one revision does not create a reopen loop.
- Terminal `garmin-connect-auth login` now continues in the shared system-browser flow when the password is left blank or Garmin returns explicit MFA/CAPTCHA page evidence.

### Security
- In the local Web bridge, email, password, MFA code, and CAPTCHA input stay inside Garmin's iframe. On the browser side, the short-lived ticket reaches only the isolated loopback bridge and is immediately passed to the Host exchange; the outer dsh page, model context, and AI-callable tool results receive neither the ticket nor DI tokens or form credentials.
- The bridge validates the expected region, message origin, iframe source, service, and ticket before the one-shot Host exchange. A ticket service is accepted only when it is the region's exact Garmin embed URL or the exact current `http://127.0.0.1:<port>` bridge origin; the ticket/service pair is preserved unchanged through DI exchange. The dsh page receives only public progress states.
- Before saving a browser-authenticated session under the configured email, the bridge now explicitly asks the user to confirm that the sanitized Garmin profile corresponds to that email.
- System-browser launching validates the exact random loopback bridge URL and uses shell-free platform launchers; Windows resolves a strictly validated absolute System32 `rundll32.exe` instead of permitting current-directory binary lookup. Passwords, MFA codes, tickets, and tokens are never accepted as CLI arguments or written to MCP tool results.
- MCP authentication never auto-replays the interrupted tool, so workout/FIT writes cannot be duplicated by authentication completion. Account/region mismatch, unsafe session permissions, transient network failures, persistence failures, and unknown write outcomes do not get misclassified as MFA prompts.
- Password authentication triggers browser recovery only from positive Garmin MFA/CAPTCHA markup. The pinned SDK's ambiguous no-ticket text, a password HTTP 401, generic sign-in HTML, network failures, and MFA-looking titles do not open a browser automatically.
- `serve` requires both `--account` and `--region` instead of inferring either from the environment. MCP fallback guidance preserves an explicitly configured session destination without echoing that local path into model context.
- POSIX session destinations are now fully prepared before browser authentication: safe links are canonicalized, ancestor ownership/write access and final effective-UID owner-only permissions are checked, missing components are created one at a time as `0700`, and the canonical parent/file state is revalidated around the no-follow atomic write.
- POSIX session reads now canonicalize a safe parent alias and verify the entire non-writable ancestor chain, private final parent, final file owner/mode/link count, and descriptor/path identity before consuming credentials. On Darwin, granting extended ACL entries are rejected on every checked directory and file even when POSIX mode bits appear private.
- Windows session storage now uses an absolute, shell-free Windows PowerShell/.NET ACL boundary: every component below the longest matching user special-folder root is atomically created or read-only verified with an exact current-SID-only DACL; existing non-exact components, session-file ACL mismatches, and reparse points are rejected. Marker-only preview directories are never trusted or rewritten.
- All browser-auth entry points now run the same session-destination preflight before starting a loopback listener. Windows implicit paths prefer local `LOCALAPPDATA`; UNC/network session destinations remain unsupported.

### Fixed
- Windows owner-only session setup now allows a bounded 30 seconds for a cold Windows PowerShell 5.1 ACL subprocess, avoiding false failures when first-launch endpoint scanning exceeds 10 seconds.
- Synchronized the dependency lockfile with the current DeepSeek Harness development packages so a clean `npm ci` succeeds in release and CI environments.
- China-region MFA tickets that Garmin binds to the current loopback bridge are now exchanged with that exact service instead of being incorrectly rewritten to the Garmin embed URL. Cross-region services, other loopback ports/hosts, paths, queries, fragments, credentials, and malformed variants are rejected before any DI request.
- Retrying or closing the Web login no longer discards an active flow handle until the Host confirms cancellation or a terminal state.
- Installing a newly authenticated session now fences new Garmin work and drains old in-process DI refresh writes before the atomic replacement, preventing a late refresh from overwriting the new session.
- A running MCP process now hot-loads a separately persisted account-matching session after missing, expired, or rejected credentials. It consumes the same private parsed snapshot used for change detection, never retries unchanged or locally unusable replacements, and still requires an explicit retry of the interrupted tool.
- After Garmin explicitly rejects an inline token, a running process may safely switch to a newly written account-bound session file; unbound legacy files cannot take over that identity boundary, and the rejected inline credential is not retried.
- `SIGINT`, `SIGTERM`, and `SIGHUP` now cancel browser-auth username and identity-confirmation prompts as well as the active controller, so terminal shutdown cannot hang while readline is waiting for input.
- Browser, canary, and `serve` CLI operations now get one bounded 35-second graceful cleanup window after the first termination signal; a second signal requests an immediate conventional signal exit.
- The system-browser launcher now detects immediate non-zero exits, MCP completion notifications have a bounded wait, and closing a flow already saving credentials drains the irrevocable commit before reporting its real result (or an explicit unknown outcome). The bridge hides cancellation after that commit point.
- Web disposal now waits for the shared flow's irrevocable save before closing its listener. CLI/MCP broker and controller drains start together rather than stacking timeouts, and MCP stdin EOF plus `SIGINT`/`SIGTERM`/`SIGHUP` run one bounded server/auth cleanup while keeping signal handlers installed through the commit window.
- A legacy configured password still works for non-MFA accounts; explicit MFA/CAPTCHA page evidence is converted to typed browser-recoverable authentication, while ambiguous no-ticket/password failures remain ordinary actionable errors.

### Changed
- The local Web, `serve`, and MCP browser-auth flows now allow 10 minutes for password, CAPTCHA, and MFA completion before expiring.
- The local dsh Web UI now presents separate China and International Garmin login buttons, validates the selected region against `GARMIN_REGION`, and uses a responsive, security-focused dialog and bridge layout.
- Once the Host has verified an account identity, the matching region button shows the configured account email as its signed-in subtitle; identity-unverified legacy OAuth tokens keep the neutral domain subtitle.
- The signed-in subtitle refreshes every 15 seconds and when the page regains focus; while unauthenticated, a one-second coarse-state poll can surface one new browser-auth requirement without a reload.
- Standalone MCP no longer requires password/token material at process startup. With `GARMIN_USERNAME`, `GARMIN_REGION`, and `GARMIN_ACCOUNT`, it derives the same owner-only account session path used by local Web and CLI authentication.
- MCP clients without URL-elicitation capability receive an actionable `garmin-connect-auth serve` fallback instead of starting a listener they cannot surface. One MCP process still owns one account; configure named `garmin-cn` and `garmin-global` processes when both regions are needed.
- Malformed, obsolete, account-mismatched, or otherwise unsafe local session files remain configuration errors and no longer trigger browser authentication; only missing, expired, Garmin-rejected credentials or positively identified browser challenges do.
- CI now exercises exact Windows DACL behavior on `windows-latest` and real Darwin inherited/file ACL behavior on `macos-latest`, in addition to the Linux Node.js build/test matrix.

### Experimental preview (status at 0.1.6-rc.1)

> Historical RC status: International-region MFA was subsequently verified and
> promoted to a supported capability in the final 0.1.6 release above.
- The embedded flow is limited to a loopback dsh Web UI on the same machine. It is not a remote, hosted, or tunneled authentication endpoint.
- Browser third-party-cookie or iframe policy may prevent Garmin GAuth from completing. On 2026-08-29, a real China-region MFA run passed the visible browser, exact loopback-bound ticket exchange, profile confirmation, owner-only session persistence, fresh-client session consumption, profile probe, and recent-activity read chain. Same-process hot loading is covered by automated tests; International-region real-account MFA and refresh-token rotation remain unverified, so the feature stays experimental.
- The new `serve` and MCP URL-elicitation paths have automated loopback/runtime coverage. The successful China-region run used the same shared runtime through a local browser. Codex CLI `0.147.0` completed real stdio initialization and received the `-32042` URL-elicitation response, but exposed the URL only in raw tool diagnostics instead of a first-class authentication prompt; ZCode, completion/retry UX, and International-region MFA still require manual verification.
- `garmin-connect-auth login --browser` and `canary` remain legacy Playwright diagnostics, not the recommended fallback for `serve` or MCP authentication.

## [0.1.5] - 2026-08-21

> This release compares against npm `0.1.4`. Browser-based Garmin two-step
> verification remains unfinished and is not release-supported.

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
- This release is not a drop-in replacement for every `0.1.4` consumer; review these compatibility changes before upgrading.

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
- Browser `garmin-connect-auth login --browser` and `garmin-connect-auth canary` remain developer diagnostics. Garmin two-step verification is unfinished and must not be presented as a supported `0.1.5` capability.
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
