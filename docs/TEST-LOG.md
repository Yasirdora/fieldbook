# Test log

Every red and green run, oldest first. "Red" means the tests failed; the last column says why.
Initial server test runs, 4 November 2026.

Swift note: the first build ran on a Linux machine with **no Swift toolchain**. `swift --version` →
`command not found`. The download host `download.swift.org` was blocked by the network policy there
(HTTP 403 on CONNECT), Ubuntu 24.04 has no `swiftlang` package, and the Docker image mirror was refused
too. So no Swift ran there; the Swift tests ran later on the Mac (see "On the Mac, 4 November 2026").
The only Swift logic checked on Linux was SHA-256: a line-by-line JavaScript port of
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

## Simulator findings fixed, 5 November 2026

The first demo run on a simulator (4 November) found that a late crash report was missed, that SwiftUI
screens had an empty accessibility tree reported as measured, that doctor counted simulators as phones,
that SwiftUI identifiers were never found, and that system log lines filled the timeline.

| # | Command | Tests | Result | Why it was red / note |
|---|---|---|---|---|
| 49 | the new tests on bb971cb (code unchanged, tests copied in): `parsers`, `timeline`, `recording-robustness` | 18 | red: 13 pass, 5 fail | Simulators listed by devicectl counted as phones; `session_stop` neither waited for a late report nor said when it looked (3 tests); `timeline.test.ts` did not load: `accessibilityText` did not exist yet. |
| 50 | the timeline tests with the new `text.ts` and the old `timeline.ts` | 2 | red: 1 pass, 1 fail | Only the system-log test: "Scene will enter foreground" was in the default timeline. |
| 51 | `npm run typecheck` | — | green | |
| 52 | `npm test` | 139 | green: 139 pass | |
| 53 | `swift test --package-path kit` | 37 | green: 37 pass | |
| 54 | `xcodebuild build` FieldbookKit, generic iOS Simulator | — | green: 0 errors | |
| 55 | demo on a scratch simulator (iPhone 17 Pro, iOS 26.5), app accessibility on: doctor; a session with relaunch; marks "list" and "detail"; `find id:pinnedBadge`, `find id:noteRow-n3`; Crash, then `session_stop` at once | — | green, one finding | doctor listed 1 phone (before: 9 false failures). Marks had 32 and 14 accessibility nodes; both identifiers were found in the accessibility tree (before: none). The crash report was written 5.1 s after the crash; stop waited for it and counted "1 new crash log". The default timeline was 5.3 KB with 418 system log lines left out (268 KB with `kinds: ["log"]`). Finding: the report header's `timestamp` is when the report was written; the crash time is the body's `captureTime`. |
| 56 | same, app accessibility off | — | green | The mark reads "accessibility tree empty (missing: …)" instead of "accessibility 1 nodes (measured)". A stop without a crash returns at once and says it looked when the session stopped. |
| 57 | `npm test` after the crash time moved to `captureTime` | 140 | green: 140 pass | `tsc` clean. |


## Phone test, 5 November 2026

The demo's Debug build on an iPhone 12 Pro (iOS 27.0.1), installed over Wi-Fi with
`devicectl device install app`, steps 12–16 and 18 of docs/TESTING-ON-MAC.md, with the tester holding
the phone. It found eight problems (F12–F19); F12–F18 are fixed below, F19 is open (docs/DESIGN.md, section 5).

| # | Command | Tests | Result | Why it was red / note |
|---|---|---|---|---|
| 58 | `devices`, `doctor`, and the JSON shapes by hand (step 12) | — | green | doctor 5 of 5: tunnel, a real screenshot, container access, Darwin round trip 1.3 s. `copy from` put `hello.json` directly in the destination; a command copied to the inbox was answered within 3 s; lock, apps and files JSON as the parsers expect. |
| 59 | a phone session (step 14): Freeze, Use 50 MB, Log an error, three shakes with a note, Mac marks "detail" and "with voiceover", Crash, `session_stop` | — | green, five findings | No permission prompt for shaking. Snapshots 90–131 ms. With VoiceOver on: 33 nodes and every identifier; `find id:noteRow-n3` → 1 match. The crash was picked up and dated from the report's capture time. F12: bare windows read "accessibility 2 nodes (measured)". F13: 236 system error lines in 24 messages buried the app's 13. F14: Freeze and Log an error gave no visible answer (the tester tapped Freeze 26 times). F16: step 14's `mark {"name": …}` lacks the session. F17: step 12 printed `.result.apps[0]`, any app on the phone. |
| 60 | MetricKit session after the crash (step 16) | — | open | No payload within 1 min 42 s. |
| 61 | Release check (step 18) | — | green, one finding | Both Release builds clean; the Debug control not clean, exit 1. F15: the Debug build was called "this Release build". |
| 62 | `scripts/pixel-diff.ts` on the phone marks (step 8) | — | red, one finding | F18: one capture was 16-bit Display P3 and could not be read. The other: 17.2 % of pixels differ (2.1 % by more than 16/255). |
| 63 | the new accessibility tests with the old `text.ts` and `mark.ts` | 8 | red: 6 pass, 2 fail | F12. Honest note: the run before had a mistake in the new test itself (wrong `kitOn` arguments). |
| 64 | the new fold test with the old `timeline.ts` | 9 | red: 8 pass, 1 fail | F13: the repeated system error showed three times. |
| 65 | `release-check.test.ts` with the old script | 11 | red: 10 pass, 1 fail | F15. |
| 66 | `pixel-diff.test.ts` with the old script | 6 | red: 5 pass, 1 fail | F18: "only 8-bit RGB or RGBA PNGs … (depth 16, color type 2…)". |
| 67 | `npm test`, `npm run typecheck` | 144 | green: 144 pass | `tsc` clean. |
| 68 | `swift test --package-path kit` | 37 | green: 37 pass | |
| 69 | demo Debug builds (iOS Simulator, macOS); the demo on a scratch simulator | — | green | F14: one tap on Freeze → "Freezes 1"; one tap on Log an error → "Errors logged 1". |
| 70 | `timeline` on the recorded phone session, with the new code | — | green | 265 lines (154 KB) → 102 lines (48 KB); 212 repeats folded into their first line; marks 1–4 read "accessibility tree empty", the VoiceOver mark "33 nodes"; all 13 of the app's own lines kept. |
| 71 | `scripts/pixel-diff.ts` on the 16-bit capture, with the new script | — | green, one finding | It reads now. F19: 93.5 % differ, because the app's snapshot and the capture were 1.1 s apart and show different scroll positions. Open. |

## Review fixes, 5 November 2026

A read-only outside review of the code found five bugs; each was confirmed with a failing test
before it was fixed.

| # | Command | Tests | Result | Why it was red / note |
|---|---|---|---|---|
| 72 | `clock-skew.test.ts` with the old ingest | 4 | red: 0 pass, 4 fail | With the phone's clock 5 s behind the Mac: a hang and a mark after the start were left out and the mark's snapshot was acknowledged without being copied; after a relaunch the new run's launch was left out; a log from just after the start was left out. |
| 73 | `npm test` with the first fix | 147 | red: 146 pass, 1 fail | The first fix judged every event after the start only by its sequence number, so a log from long before the session that the kit read late counted. Now such a log is compared with the run's newest earlier event, on the phone's own clock. |
| 74 | `clock-skew.test.ts`, a fourth test (a log read late), with the fix | 4 | red: 3 pass, 1 fail | Honest note: the test itself was wrong. Its fake kit wrote nothing for 60 s before the start; the real kit writes a memory sample every 2 s. With that sample it is green. |
| 75 | `clock-skew.test.ts` with the fix | 4 | green: 4 pass | |
| 76 | the mailbox-search and stop tests with the old code | 2 | red: 0 pass, 2 fail | A broken link in the copy threw ENOENT from `stat`. A stop that failed once (the session folder could not be written) gave back the same error on every later stop. |
| 77 | the cut-off timeline tests with the old code | 2 | red: 0 pass, 2 fail | `SyntaxError` on a last line cut off mid-write; the next pull's line was glued onto it. |
| 78 | the Mac mailbox test with the old code | 1 | red: 0 pass, 1 fail | An old sandbox container won over the newer mailbox of a build without sandbox. |
| 79 | the system-message compare test with the old code | 1 | red: 0 pass, 1 fail | A new UIKit message made `newErrors` warn. |
| 80 | each set with its fix; `npm test`, `npm run typecheck` | 154 | green: 154 pass | `tsc` clean. |
