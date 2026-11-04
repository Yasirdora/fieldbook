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
| 16 | `node --test test/release-check.test.ts` | 8 | red: 0 pass, 8 fail | `scripts/check-release-clean.sh` did not exist yet. |
| 17 | same | 8 | green: 8 pass | The script is tested with fake .app folders (iOS and macOS layout) and a fake `nm` on PATH. `bash -n` passes. shellcheck is not installed here. |
| 18 | `npm test` | 91 | green: 91 pass | |
| 19 | `node --test test/kit-rules.test.ts` | 4 | green: 4 pass | Scans `kit/Sources` for banned constructs. Honest note: no red run — it checks code that already followed the rules; its last test proves the scan finds a banned construct in a sample. |
| 20 | `node --test test/pixel-diff.test.ts` | 5 | green: 5 pass | Honest note: the test and `scripts/pixel-diff.ts` were written together, so there was no red run. `tsc` then failed because `scripts/` had no `"type": "module"`; fixed with `scripts/package.json`. |
| 21 | `npm test` | 100 | green: 100 pass | `tsc` clean. |

## Server review fixes

An adversarial review (3 finders, 3 skeptics) read the server. These rows record the fixes.

| # | Command (in `server/`) | Tests | Result | Why it was red / note |
|---|---|---|---|---|
| 22 | `node --test test/hostile-mailbox.test.ts` | 7 | red: 0 pass, 7 fail | Untrusted mailbox data: a `..` snapshot id let the snapshot tool write outside the session; a `..` command id filed a foreign picture; a folder or link in a snapshot, a `constructor` mark id, or one malformed event broke or skewed the pull; a stray outbox file name set the ack; device id and name reached evidence.json. |
| 23 | same, after the fixes | 7 | green: 7 pass | |
| 24 | `npm test` | 107 | green: 107 pass | `tsc` clean. |
| 25 | `node --test test/analysis-robustness.test.ts` | 8 | red: 0 pass, 8 fail | Evidence mixed saved verdicts with later data; non-finite numbers became "measured"; a mark with no snapshot passed; newErrors passed when b was never read; a crash log that failed to copy counted as 0; a broken tree threw in compare and find; find said "no match" when a mark had no trees; the header said "0 hangs" for a missing count; a blank mark picked an unnamed mark. |
| 26 | same, after the fixes | 8 | green: 8 pass | |
| 27 | `npm test` | 115 | green: 115 pass | `tsc` clean. |
| 28 | `node --test test/recording-robustness.test.ts` | 7 | red: 0 pass, 7 fail | A foreign command id was trusted for a capture; two recorders after a restart; work after stop; a failed relaunch reported as done (stderr lost); two sessions on one app; crash logs matched by prefix only; the Mac capture used the newest snapshot's window, not the mark's. |
| 29 | same, after the fixes | 7 | red: 6 pass, 1 fail | The test's own ordering: `sessionStop` reaches the recorder only after one `await`, so its "late" pull was really queued before the stop. The test now queues it after both stops started. No code changed for it. |
| 30 | `npm test` | 122 | green: 122 pass | `tsc` clean. |
| 31 | `node --test test/hostile-mailbox.test.ts` | 8 | red: 7 pass, 1 fail | New test: a mark naming a snapshot that never arrives was waited for forever (raised by the kit fixer). |
| 32 | `npm test` | 123 | green: 123 pass | Pending copies now give up after 30 pulls and say so; `tsc` clean. |

## Second kit review (kit-server contract)

| # | Command (in `server/`) | Tests | Result | Why it was red / note |
|---|---|---|---|---|
| 33 | `node --test test/contract.test.ts test/release-check.test.ts` | 16 | red: 8 pass, 8 fail | A snapshot the app could not store was reported as "did not answer"; a Mac screen-only snapshot had no window number; skipped event lines left no trace; logs were filtered by read time, not log time; an empty mark name was kept; the app's own text mode was never shown; type names did not match across module prefixes; a debug dylib next to the binary was not scanned. |
| 34 | same, after the fixes | 16 | red: 15 pass, 1 fail | The test's own wording: it looked for "does not match", the message says "fields do not match". The test was corrected. |
| 35 | `npm test` | 131 | green: 131 pass | `tsc` clean. |

## Swift (written, not run — compiled and run on the Mac since, see below)

Test files in
`kit/Tests/FieldbookCoreTests/`: `RedactionTests`, `FormatFixtureTests`, `MailboxTests`,
`TreeWalkTests`, `JSONValueTests`, `KitSourceRulesTests`. Checks that did run here on the Swift code:
the node scan `server/test/kit-rules.test.ts` (4 pass) and, by the kit writer, a tree-sitter Swift
grammar parse of the 23 kit files (no syntax errors) — a grammar check, not a compile.

## On the Mac, 4 November 2026

macOS 27.0, Xcode 27.2, Swift 6.4.2, Node v26.3.1, at 4722ec1. Every run held the Mac's shared check
lock. Logs are stored in `fieldbook-test/`.

| # | Command | Tests | Result | Why it was red / note |
|---|---|---|---|---|
| 36 | `swift build --package-path kit` | — | green: 0 errors | The first compile of the Swift. No error and no change needed. |
| 37 | `xcodebuild build` FieldbookKit, generic iOS Simulator | — | green: 0 errors | |
| 38 | `swift test --package-path kit` | 37 | red: 36 pass, 1 fail | `theScanFindsBannedSamples`: Swift `Regex` uses Unicode word boundaries by default, where a full stop between letters does not end a word, so `\bURLSession\b` missed `URLSession.shared`. `sourcesContainNoBannedConstruct` would have let such a call into kit/Sources; the node scan (`kit-rules.test.ts`, plain `\b`) still caught it. |
| 39 | `npm test` (in `server/`) | 131 | red: 126 pass, 5 fail | Four release-check tests: on a Mac, `strings` parses Mach-O and refuses the short fake binaries ("truncated or malformed object", exit 1); the script threw the error away and read it as "not found", so a Release check that cannot look passed. On Linux, GNU `strings` reads raw bytes. One hostile-mailbox test: its link pointed at `/etc/hostname`, which macOS does not have, and the fake device's `cpSync` stopped with EEXIST. |
| 40 | `npm run typecheck` | — | green | |
| 41 | the fixes: `check-release-clean.sh` reads raw bytes with `grep -a` (no parser), names a file it cannot read as a hit "(unreadable)", and fails when `nm` cannot read the binary; the clean-build test uses a fake `nm` on every system (it had passed on a Mac only because the real `nm`'s error was thrown away); the hostile test links to a file it writes itself; the kit scan uses `.wordBoundaryKind(.simple)`. Two new tests: a file that cannot be read fails; a binary `nm` cannot read fails. | | | |
| 42 | `npm test` | 133 | green: 133 pass | `tsc` clean. |
| 43 | `swift test --package-path kit` | 37 | green: 37 pass | |
| 44 | `node --test test/release-check.test.ts` with the script from 4722ec1 | 11 | red: 5 pass, 6 fail | The red run for the fix: the four tests above and both new tests. |
| 45 | deliberate break a: an unreadable file counts as not found | 11 | red: 10 pass, 1 fail | Only "a file that cannot be read fails, and is named". |
| 46 | deliberate break b: an `nm` error passes | 11 | red: 10 pass, 1 fail | Only "on macOS, a binary nm cannot read fails instead of passing". |
| 47 | deliberate break c: Unicode word boundaries again | 4 | red: 3 pass, 1 fail | Only `theScanFindsBannedSamples`. |
| 48 | `node --test test/hostile-mailbox.test.ts`, alone | 8 | green: 8 pass | A second clean run of the changed test. |

Measured on the way: `nm -a` on a fully stripped copy of a real binary exits 0, so failing on an `nm` error does not
fail a stripped Release build. Still open from docs/TESTING-ON-MAC.md: the demo on a scratch simulator, the Mac app,
and the phone.
