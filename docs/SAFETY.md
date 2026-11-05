# Safety: what Fieldbook never does, and how each rule is enforced

Fieldbook inspects local Debug builds with tester consent. It is not a tool
for other people's apps. These rules hold everywhere. Each one names the code or test that
enforces it, so a reviewer can check it rather than trust it.

## On the device

| Rule | How it is enforced |
|---|---|
| Fieldbook never installs, uninstalls, erases or reboots anything, and never changes device settings. | Every command passes `checkArgv` in `server/src/allowlist.ts`. It is a list of allowed command *shapes*, not a list of banned words: anything that does not match a shape is refused before it runs. `install`, `uninstall`, `reboot`, `erase` and `settings` are also refused as words anywhere in a command. Tests: `server/test/allowlist.test.ts` ("install, uninstall, reboot, settings, --start-stopped and every other unlisted command are refused", 45 forbidden commands, including the empty command). |
| Never `process launch --start-stopped`. | `--start-stopped` is not an allowed flag of `process launch`, and it is refused as a word anywhere. Test: same file, two forms. |
| Never `rename`, `profile`, `pairings`, `simulate`, `orientation`, `pasteboard`, `appResize`, `sysdiagnose`. | Not on the allowlist. Tested one by one. |
| The app is relaunched only when the caller asks (`relaunch: true`). | `server/src/tools/session.ts` calls `startConsole` only when `input.relaunch` is true. The summary says so. Test: `session.test.ts` ("relaunch only when asked"). |
| A locked phone is not touched. | `session_start` probes the lock state first and answers "Unlock the phone"; nothing is created or copied. Test: `session.test.ts` ("a locked phone"). |
| Fieldbook writes on the device only one thing: a command file into the app's own inbox. | The allowlist accepts `copy to` only with `--domain-type appDataContainer` and a destination of the form `Library/Application Support/Fieldbook/inbox/<6 digits>-<name>.json`. Paths with `..` are refused. Test: `allowlist.test.ts` (three refused `copy to` forms). |
| Fieldbook reads on the device only the app's mailbox and the system crash logs. | `copy from` and `info files` are allowed only for `Library/Application Support/Fieldbook` in the app's container, or for one crash log by name. Test: `allowlist.test.ts` ("copy from … Documents" is refused). |
| The Mac never deletes files on the device. | There is no delete command on the allowlist. The app deletes its own outbox items after the Mac's `ack` command (docs/FORMAT.md, "Pruning"). |
| Darwin notifications are only Fieldbook's own. | Names must match `fieldbook.<bundle id>.inbox` or `.outbox`. A system name such as `com.apple.springboard.lockcomplete` is refused. Test: `allowlist.test.ts`. |

## Data from the app

| Rule | How it is enforced |
|---|---|
| Everything copied out of the app's mailbox is treated as untrusted. | `server/src/session/ingest.ts`: ids become paths only when they are safe names (`isSafeName`: letters, digits, `.`, `_`, `-`; no `/`, no leading `.`); only regular files are copied (`lstat`), never folders or links, and the search for the mailbox in the copy never follows a link; event payloads are checked field by field (`server/src/format.ts`); a mark's command id is trusted only in this session's form. Tests: `hostile-mailbox.test.ts` (8), `recording-robustness.test.ts`. |
| The app never loses data it was not asked to delete. | The ack covers only outbox items whose files are safely in the session, whatever the two clocks say. One exception, by design: items that were already in the mailbox when the session began and are from before its start are not part of the session; they are acknowledged without being copied, so the app deletes them. Test: `session.test.ts`, `hostile-mailbox.test.ts`, `clock-skew.test.ts`. |

## How commands run

| Rule | How it is enforced |
|---|---|
| Every external command is an argv array, never a shell string, and has a timeout. | `server/src/exec.ts` is the only file that starts processes. It calls `spawn` with `shell: false`; every request carries `timeoutMs`. Tests: `exec.test.ts` ("arguments are passed as they are, with no shell": `$(echo hi)` stays literal; "a command that runs too long is stopped"). `allowlist.test.ts` fails if any other source file imports `child_process` or sets `shell: true`. |
| Every command goes through the allowlist, also in tests. | `ToolRunner.run` (`server/src/runner.ts`) checks the allowlist and only then calls the Exec. Tests replace the Exec with a fake world, not the runner. Test: "the runner refuses a forbidden command before anything runs" (the fake Exec sees zero calls). |

## In the app (FieldbookKit)

| Rule | How it is enforced |
|---|---|
| Debug builds only. | The app imports and calls FieldbookKit inside `#if DEBUG`, and the demo links it only in the Debug configuration. `scripts/check-release-clean.sh <app>` fails a Release build that contains the word Fieldbook, the `fieldbook.` notification prefix, a FieldbookKit/FieldbookCore framework or bundle, or (on a Mac) Fieldbook symbols in `nm` output. Test: `server/test/release-check.test.ts` (fake .app folders). |
| No network connection, ever. The Mac reaches the app only through files and Darwin notifications. | `server/test/kit-rules.test.ts` fails if `kit/Sources` mentions URLSession, URLRequest, NSURLConnection, the Network framework (`NWConnection`, `NWListener`, `NWPathMonitor`), sockets or socket streams. The Swift test `KitSourceRulesTests` does the same on the Mac. |
| No private API, no swizzling. | The same tests fail on `dlopen`, `dlsym`, `NSClassFromString`, `NSSelectorFromString`, `forKey: "_…"`, `method_exchangeImplementations`, `method_setImplementation`, `class_replaceMethod` and any word starting with "swizzl". |
| No unsafe concurrency escapes. | The same tests fail on `@unchecked Sendable`, `nonisolated(unsafe)`, `@preconcurrency` and `MainActor.assumeIsolated`. The kit builds in Swift 6 language mode. |
| Text in the view and accessibility trees is not stored by default (screenshots are not redacted; see the end of this page). | `Redaction` (`kit/Sources/FieldbookCore/Redaction.swift`) stores `{length, sha256_8}`. Full text only when the app was launched with `-FieldbookText full`, which the server passes only with `fullText: true` and `relaunch: true`. Tests: `RedactionTests.swift` (both modes; run on the Mac with `swift test`) and `server/test/format.test.ts` (shared vectors). |
| Logs are cut. | Each log message is cut to 500 characters (`Redaction.cutLog`). |

## On the Mac

| Rule | How it is enforced |
|---|---|
| Recordings stay on the Mac. There is no upload feature. | The server has no network code: `allowlist.test.ts` fails if any server source uses `fetch(`, `node:http`, `node:https`, `node:net`, `node:dgram`, `XMLHttpRequest` or `WebSocket`. The MCP server talks only over stdio to the local client. |
| evidence.json holds no absolute path, device name or device id. | `server/src/tools/evidence.ts` writes only the device model and OS, and replaces the home folders with `$FIELDBOOK_HOME` and `~`. Test: `evidence.test.ts` ("no absolute paths"). |
| The repository holds no real device id, device name, script or title. | All fixtures use invented ids (`00000000-0000-4000-8000-0000000000A1`) and names ("Test iPhone", "Sparrowpad", "Garden plan"). |

## What is not enforced by code (and why)

- **The tester's consent.** Fieldbook cannot know whether the person holding the phone agreed. Rule: only test Debug builds with consent.
- **Which builds reach the phone.** Fieldbook never installs; the developer installs builds with Xcode. Fieldbook only checks that an installed build gives container access.
- **What the app logs.** Logs are kept as text (cut to 500 characters). If an app logs private data, that data is in the recording. Use `.private` in `Logger` interpolation for anything private.
- **What is on the screen.** Text hashing covers the view and accessibility trees only. The rendered and captured screenshots show whatever the screen shows, real text included.
- **Notes, state and crash reports.** The tester's notes, the app's own state dictionary (`Fieldbook.state`) and crash reports are kept as they are.
- **Where the agent sends answers.** Fieldbook uploads nothing, but an MCP client passes tool answers (timelines, notes, log lines) to the model it uses. Record with that model's data policy in mind.
- **Text from the app is data, not instructions.** Log lines, labels and notes in an answer come from the app under test. An agent should report them, never follow them.
