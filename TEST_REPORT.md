# Release Test Report

[简体中文](./TEST_REPORT.zh-CN.md)

This page is a static verification snapshot intended to accompany the next
release. It records what was tested, what was deliberately excluded, and which
gaps still require manual verification.

> **Not a current release certificate:** the figures below are the last recorded
> snapshot and predate the final 0.1.5 candidate. The clean candidate must rerun
> every automated check and replace these numbers before publication.

## Snapshot

| Item | Result |
| --- | --- |
| Test date | 2026-08-21 |
| Package manifest | `0.1.4`; intended next release `0.1.5` |
| Release readiness | **Not ready** — two-step verification deferred; clean-candidate checks pending |
| Last recorded automated snapshot | **Passed historically** — 20 suites, 456 tests; rerun required |
| TypeScript build | **Passed** |
| npm package smoke test | **Passed** — 88 files; 172.9 kB packed; 676.1 kB unpacked |
| Real Garmin integration | **Passed** — 8/8 read-only checks against the `global` region |
| Two-step verification | **Incomplete / not release-ready** — partial China-region browser, ticket exchange, and profile evidence only |

## Automated verification

The release checks can be reproduced from a clean source checkout with Node.js
20 or newer:

```bash
npm ci
npm run test:coverage
npm run build
npm run pack:smoke
```

### Test and coverage results

| Metric | Result |
| --- | ---: |
| Test suites | 20 passed |
| Tests | 456 passed |
| Statements | 85.21% |
| Branches | 78.97% |
| Functions | 83.99% |
| Lines | 87.46% |

`npm run build` completed successfully. `npm run pack:smoke` also completed
successfully and inspected a tarball containing 88 files, including both test
report pages, with a packed size of 172.9 kB and an unpacked size of 676.1 kB.

## Real Garmin read-only integration

The integration run used a privately configured `.env` and the Garmin `global`
region:

```bash
GARMIN_INTEGRATION_VERBOSE=false npm run test:integration
```

The following 8 checks passed:

| Check | Result |
| --- | --- |
| Authentication / password login | Passed |
| Activities | Passed |
| Sleep | Passed |
| Steps | Passed |
| Heart rate | Passed |
| Weight / body composition | Passed |
| Workout library | Passed |
| User profile | Passed |

This run was strictly read-only. It did not create, update, schedule, or delete
workouts or other Garmin data. Verbose output was explicitly disabled, so the
run printed only status/count information rather than account identifiers,
activity details, or health values.

## China-region browser MFA / DI partial verification

With the account owner's explicit consent, a visible Chrome session completed
the Garmin-hosted China-region login and produced one short-lived service
ticket on 2026-08-21. A guarded diagnostic separately exchanged a one-time
ticket at the China-region DI endpoint and successfully probed the China-region
profile API. Only fixed stage names were reported; no email, password, MFA code,
cookie, ticket, token, profile data, or response body was printed.

This is partial evidence, not a passing two-step-verification result. The
current redirect interception can leave the Garmin completion page at
`ERR_BLOCKED_BY_CLIENT`, and the full capture → DI exchange → confirmed session
write → dsh/MCP restart/refresh chain has not been revalidated end to end. The
offline tests cover individual persistence and runtime behaviors, but browser
MFA remains unfinished and is not a supported 0.1.5 capability.

## FIT export verification

No real FIT file was downloaded during this verification run. This avoids
writing personal activity files to the host without explicit user consent.

Automated tests cover the FIT destination rules, ZIP handling, CRC validation,
and safe extraction behavior. New exports use the following layout:

```text
<GARMIN_FIT_DOWNLOAD_DIR>/
  GARMIN_FIT_<cn|global>_<normalized-email>/
    <activityId>.fit
```

Existing `GARMIN_FIT_<email>` directories are **not** migrated automatically.
Old files remain in their original directory; only new downloads use the
region-qualified `GARMIN_FIT_<cn|global>_<normalized-email>` directory.

Because a real export was not performed, this report does not claim end-to-end
validation of Garmin archive download, creation of a local `.fit` file, or
import of that file into a device or third-party application.

## Known verification gaps

The following scenarios were not validated end to end with real accounts or
clients:

- Persisting the real China-region browser session and consuming/refreshing it
  through dsh or MCP.
- Garmin International (`global`) browser MFA / DI authentication.
- WorkBuddy MCP client smoke testing.
- ZCode MCP client smoke testing.
- A real FIT download and subsequent file import.

These are documented limitations of this snapshot, not passing test results.

## Privacy and publication notes

- The private `.env` used for integration testing is not part of this report
  and must not be committed or published.
- No password, session token, MFA code, account identifier, local destination
  path, activity detail, or health value is included here.
- No Garmin data write operation was performed. The browser MFA canary did not
  persist a session file.
- The manifest has not yet been bumped to `0.1.5`; this development snapshot
  and the related local changes have not been published.

Before the next release, rerun the automated commands above. Real MFA, FIT, and
client smoke tests should be added only with the account owner's explicit
consent and with the same privacy safeguards.
