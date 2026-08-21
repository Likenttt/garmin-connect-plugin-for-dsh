# Release Test Report

[简体中文](./TEST_REPORT.zh-CN.md)

This page is a static verification snapshot intended to accompany the next
release. It records what was tested, what was deliberately excluded, and which
gaps still require manual verification.

## Snapshot

| Item | Result |
| --- | --- |
| Test date | 2026-08-21 |
| Package version | `0.1.4` (not published) |
| Automated tests | **Passed** — 20 suites, 456 tests |
| TypeScript build | **Passed** |
| npm package smoke test | **Passed** — 88 files; 172.9 kB packed; 676.1 kB unpacked |
| Real Garmin integration | **Passed** — 8/8 read-only checks against the `global` region |
| China-region browser MFA / DI probe | **Passed** — browser MFA, one-time ticket exchange, and profile probe; no session persisted |

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

## China-region browser MFA / DI verification

With the account owner's explicit consent, a visible isolated Chrome session
completed the real China-region MFA flow on 2026-08-21. The diagnostic caught
one short-lived Garmin service ticket before the browser consumed it, exchanged
it once at the China-region DI endpoint, and successfully probed the China-region
profile API. Only fixed stage names were reported; no email, password, MFA code,
cookie, ticket, token, profile data, or response body was printed.

This was intentionally a non-persisting canary. It proves the real browser MFA →
DI exchange → profile-probe chain, but it does not yet prove that a saved DI v2
session can restart dsh/MCP, refresh a rotated token, and serve normal Garmin
tools end to end. Those persistence and runtime behaviors are fully covered by
offline automated tests and remain a separate live verification gate.

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
- The package remains at version `0.1.4`; this verification snapshot and the
  related local changes have not yet been published.

Before the next release, rerun the automated commands above. Real MFA, FIT, and
client smoke tests should be added only with the account owner's explicit
consent and with the same privacy safeguards.
