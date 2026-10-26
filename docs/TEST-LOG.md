# Test log

Every red and green run, oldest first. "Red" means the tests failed; the last column says why.
Initial server test runs, 4 November 2026.

Swift note: this machine has **no Swift toolchain**. `swift --version` → `command not found`.
The download host `download.swift.org` is blocked by the network policy here (HTTP 403 on CONNECT),
Ubuntu 24.04 has no `swiftlang` package, and the Docker image mirror was refused too. So no Swift
Swift tests are documented in docs/TESTING-ON-MAC.md.
The only Swift logic checked here is SHA-256: a line-by-line JavaScript port of
`kit/Sources/FieldbookCore/SHA256.swift` matched `node:crypto` on 8 of 8 inputs, and its 64 round
constants match.

## Phase 1

| # | Command (in `server/`) | Tests | Result | Why it was red / note |
|---|---|---|---|---|
| 1 | `node --test test/allowlist.test.ts test/exec.test.ts` | 2 files | red: 0 pass, 2 fail | `src/allowlist.ts` and `src/exec.ts` did not exist yet (`ERR_MODULE_NOT_FOUND`). |
| 2 | same | 9 | green: 9 pass | `tsc` clean. |
| 3 | `node --test test/parsers.test.ts test/format.test.ts` | 7 results | red: 6 pass, 1 fail | `src/format.ts` did not exist yet. Honest note: the 6 parser tests passed at once, because the parser code was written in the step before them; they had no red phase. |
| 4 | same | 13 | green: 13 pass | `tsc` clean. |
| 5 | `node --test test/devices-tool.test.ts test/doctor.test.ts test/session.test.ts test/timeline.test.ts` | 4 files | red: 0 pass, 4 fail | `src/tools/*.ts` did not exist yet. |
| 6 | same, after writing the tools | 28 | red: 27 pass, 1 fail | The failing check was wrong, not the code: it looked for " memory " in every line and matched "peak memory" in the header. The check now looks only at timeline lines. |
| 7 | `npm test` | 50 | green: 50 pass | `tsc` reported 13 "possibly null" errors in two test files; fixed with non-null marks. |
| 8 | `node --test test/mcp.test.ts`, `node --test test/stdio.test.ts` | 5 | green: 5 pass | Honest note: written before `src/mcp.ts` and `src/main.ts`, but not run before the code existed, so no red run was recorded. |
| 9 | `npm test` | 55 | green: 55 pass | `tsc` clean. |

## Phase 3 (server side)

| # | Command (in `server/`) | Tests | Result | Why it was red / note |
|---|---|---|---|---|
| 10 | `node --test test/mark.test.ts test/find.test.ts test/metrickit-crash.test.ts` | 3 files | red: 5 pass, 2 files fail | `src/tools/mark.ts` and `src/tools/find.ts` did not exist yet. Honest note: the 5 MetricKit and crash tests passed at once, because ingest (MetricKit copies) and session_stop (crash pickup) were written in phase 1. |
| 11 | same | 18 | green: 18 pass | |
| 12 | `npm test` | 73 | green: 73 pass | `tsc` clean. |

## Phase 4 (server side)

| # | Command (in `server/`) | Tests | Result | Why it was red / note |
|---|---|---|---|---|
| 13 | `node --test test/compare.test.ts test/evidence.test.ts` | 2 files | red: both fail | `src/tools/compare.ts` and `src/tools/evidence.ts` did not exist yet. |
| 14 | same, after writing them | 10 | red: 9 pass, 1 fail | The check was too strict: it banned the word "score" in the summary, which says "there is no overall score". The check now looks for a score value (`score:`, `x/y points`, `overall:`). No code changed for it. |
| 15 | `npm test` | 83 | green: 83 pass | `tsc` clean; compare and evidence registered as MCP tools. |
