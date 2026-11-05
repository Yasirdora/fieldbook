# Fieldbook design

Fieldbook provides runtime observability for iOS and macOS Debug builds:
what the app logged, crashes, memory, main-thread hangs, launch time, and — at moments the tester
marks — a screenshot, the view and accessibility trees, and the app's own state. Two recordings
of the same steps can be compared with clear rules.

Every claim below carries one tag:

- **[measured]** — verified with test suite run (Node 22, 4 Nov 2026);
- **[read]** — taken from a document or file, with its link;
- **[guess]** — not checked. All guesses are also listed together at the end, with the step in
  docs/TESTING-ON-MAC.md that checks them.

## 1. The parts and how they talk

```
 iPhone / simulator / Mac app (Debug)                    The Local Mac
 ┌───────────────────────────────┐                 ┌───────────────────────────────┐
 │ App + FieldbookKit            │                 │ Fieldbook MCP server (Node)   │
 │   writes the mailbox:         │  devicectl copy │   devices · doctor · session  │
 │   Library/Application Support/│ ───────────────▶│   mark · snapshot · find      │
 │   Fieldbook/  (hello, events, │  from (pull)    │   timeline · compare ·        │
 │   snapshots, outbox)          │                 │   evidence                    │
 │   reads inbox/ commands       │ ◀────────────── │   $FIELDBOOK_HOME/sessions/   │
 │                               │  copy to inbox  │                               │
 │                               │  + Darwin notif.│                               │
 └───────────────────────────────┘                 └───────────────────────────────┘
```

- **Files and Darwin notifications only.** The kit opens no network connection. The Mac copies the
  mailbox out with `devicectl device copy from` (phone) or plain file reads (simulator, Mac), and puts
  commands in with `copy to` or a file write, then posts the Darwin notification
  `fieldbook.<bundle id>.inbox`. *Why:* devicectl already has an authenticated channel to the phone
  and gives container access to development builds; a network listener in the app would be a new
  attack surface and would need a permission on iOS. [read: devicectl documentation]
- **The Mac never deletes on the device.** The app deletes its own outbox items when the Mac sends
  `ack`. *Why:* devicectl has no delete in the allowed list, and an app that owns its files cannot
  be left with a half-deleted folder by the Mac. (docs/FORMAT.md, "Pruning")
- **Polling plus a signal.** The app reads its inbox on the notification, and every 2 s while active
  as a fallback; the Mac copies the mailbox every 5 s. *Why:* whether a Darwin notification posted by
  devicectl reaches the app is not known yet [guess G1]; the 2 s read works either way.
- **One format, two languages.** docs/FORMAT.md is the contract. The shared files in
  `fixtures/format-v1/` are read by both the Swift tests and the TypeScript tests.

## 2. Decisions and their reasons

### The server

1. **TypeScript run directly by Node, no build step.** Node 22.23 strips types when it runs a `.ts`
   file. [measured: `node a.ts` with `const x: number = b(2)` printed `ok 4`]
   The code uses only "erasable" TypeScript (no enums, no parameter properties), which `tsc` checks
   (`erasableSyntaxOnly` in `server/tsconfig.json`).
2. **Dependencies.** Runtime: `@modelcontextprotocol/sdk` 1.32.2 and `zod` 4.6.7, pinned exactly.
   [measured: `npm view @modelcontextprotocol/sdk version` → `1.32.2`; its `peerDependencies` list
   `zod: ^3.25 || ^4.0`] For checking only: `typescript` 6.0.3 and `@types/node` 22.20.5 as exact
   dev dependencies. The two dev dependencies never run with the server; they only power
   `npm run typecheck`. The server itself needs nothing but the SDK and zod.
3. **The MCP server API.** `McpServer.registerTool(name, {title, description, inputSchema}, handler)`
   with zod shapes, and `StdioServerTransport`. [read: `server/node_modules/@modelcontextprotocol/sdk/README.md`
   and `dist/esm/server/mcp.d.ts` of version 1.32.2] Tested end to end with the SDK's
   `InMemoryTransport` and by starting `node src/main.ts` over stdio. [measured: `npm test` → 154 pass]
4. **Each answer is a summary, then JSON.** Two text blocks. A mistake the caller can fix (unknown
   session, refused command) is an MCP error with a plain sentence. (`server/src/mcp.ts`)
5. **Evidence labels on every value:** measured, captured, rendered, reported, missing — never
   upgraded. Modelled on Code Director's evidence classes and its rule that a claim without an artifact
   is downgraded. [read: `codedirector/src/verify/types.ts` at commit f80110a, `enforceArtifactRule`]
6. **One gate for commands.** `exec.ts` is the only file that starts a process: argv array,
   `shell: false`, a timeout. `runner.ts` checks the allowlist before every run, also in tests.
   (docs/SAFETY.md)
7. **An allowlist of shapes, not a blocklist of words.** A blocklist misses what nobody thought of.
   The allowlist names each subcommand, each flag, and the form of each value (device id, bundle id,
   Fieldbook notification name, inbox path). [measured: 45 forbidden commands refused in `allowlist.test.ts`]
8. **devicectl JSON goes to a file** (`--json-output <file>`), never `-`, because `-` is not allowed
   together with `process launch --console`. [measured] The console run uses no JSON
   output at all.
9. **properties.\* first, deprecated fields as fallback** when reading `list devices`. The tunnel
   state exists only in the deprecated `connectionProperties.tunnelState`. [measured]
   So reachability is **measured by asking**: `info lockState` answers only over a working
   connection. A phone is "reachable" when that command succeeds.
10. **The mailbox copy is kept between pulls** (`raw/pull/`), so a copy that skips unchanged files
    costs little. `copy to` skips unchanged files [measured]; whether `copy from`
    does is unknown [guess G2]. The server finds the mailbox folder inside the copy whether devicectl
    copies the folder itself or its contents [guess G2; both forms are tested]. The search never
    follows a link and skips an entry it cannot read. [measured: `hostile-mailbox.test.ts`]
11. **Ingest is idempotent.** It remembers, per run, the highest event `seq` and any gaps below it (so events copied across a log rotation are not lost), and the marks it filed
    (`raw/ingest.json`), so a second pull files nothing twice. What happened before the session is
    left out, without letting the two clocks decide what came after: only what the mailbox already
    held when the session began is compared with the Mac's start time (minus 2 s). Later events
    count by their sequence number, and a log the kit read late is compared with the run's newest
    earlier event, on the device's own clock. Before a relaunch the server notes the mailbox, so the
    new run counts in full. [measured: `session.test.ts`, `contract.test.ts`, `clock-skew.test.ts`
    with the phone's clock 5 s behind] A timeline line cut off when the server stopped mid-write is
    left out, later lines start on their own line, and a stop that failed can be tried again.
    [measured: `recording-robustness.test.ts`]
12. **Marks come from mark events; the outbox only drives the ack.** The mark event is written in
    the same step as the snapshot, while the outbox can drop items when full. Late snapshot files and
    late MetricKit files are retried on the next pull.
13. **The real screenshot is taken at the moment of the mark** (phone and simulator: in parallel with
    sending the command). On the Mac, `screencapture -l` needs the window number, which comes with the
    app's snapshot (`NSWindow.windowNumber`), so the Mac capture follows the snapshot by a fraction of a
    second. [guess G9: that `windowNumber` is the id `screencapture -l` wants]
14. **Crash pickup by difference.** At session start the server lists the crash logs; at stop it
    copies the new ones named exactly `<executable>-YYYY-MM-DD-HHMMSS[.n].ips` (or `.crash`), and drops
    a copied log whose first line (the .ips header) names another bundle id. A listed log that cannot
    be copied still counts, with the reason. Phone: `systemCrashLogs` through
    devicectl. Simulator and Mac apps: the Mac's `~/Library/Logs/DiagnosticReports`. [guess G10 for
    the simulator location] A crash count that could not be measured is *missing*, never 0.
15. **compare never gives one score.** Each rule shows both numbers and pass, warn, fail — or
    *unchecked* when a number is missing. Unchecked is an addition to the brief's three words: a rule
    that cannot be judged must not pass. New error messages from the app (numbers stripped) are
    warnings, never failures. New messages from Apple's frameworks (`com.apple.*`) are listed, not
    judged: an unchanged app logged 236 such lines in 17 minutes on the phone. [measured:
    `compare.test.ts`]
16. **evidence.json is self-contained** (the numbers, labels, thresholds and verdicts are inside it)
    and **verifiable** (every cited file with its sha256). It carries the device model and OS but no
    device name or id.
17. **The mailbox is untrusted data.** An app bug could write anything into it. Names from it become
    paths only when they are safe names; only regular files are copied (no folders, no links); every
    event payload is checked field by field; one bad event or file becomes a `problem` entry and the
    pull goes on. A mark's command id is trusted only in this session's own form (`<session id>-<n>`).
    The ack covers only outbox items whose snapshot and file are safely in the session (an item may
    hold it back for at most 5 pulls). [measured: `hostile-mailbox.test.ts`, `recording-robustness.test.ts`]
18. **One recording per app and device**, and one recorder per session: `session_start` refuses a
    second session while one records the same app on the same device; overlapping calls after a
    server restart share one recorder; calls after `session_stop` do nothing.
19. **Mac relaunch is not offered.** No allowed command starts a Mac app with its console; the developer
    starts it from Xcode.

### The kit

20. **FieldbookCore is platform-neutral** (Foundation only), so it could build and be tested on Linux.
    It has its own SHA-256, because CryptoKit does not exist on Linux and swift-crypto would be a
    dependency. [measured: a line-by-line JavaScript port of `SHA256.swift` matched `node:crypto` on
    8 of 8 inputs; its 64 round constants match]
21. **All mailbox file work runs on one actor** (`Mailbox`), never on the main thread. Files are
    written to a hidden temporary file and renamed. Snapshot folders are written hidden and renamed
    whole, so the Mac never copies half a snapshot. Events are appended; a reader ignores a last line
    without a line break.
22. **Text in the trees is fingerprinted, not stored.** `{length, sha256_8}` by default (screenshots
    are pixels of the whole screen and are not redacted); full text only with the
    launch argument `-FieldbookText full`. `find` and `compare` still work on fingerprints: the server
    hashes the query.
23. **Tree walks stop at 5000 nodes** and say so (`truncated`). One generic walk (`TreeWalk`) serves
    UIKit views, AppKit views, accessibility elements and test fakes.
24. **Darwin notifications through `CFNotificationCenterGetDarwinNotifyCenter`.** They are system-wide
    and are delivered only while the main thread's run loop runs in a common mode, so the callback
    arrives on the main thread. [read: https://developer.apple.com/documentation/corefoundation/cfnotificationcentergetdarwinnotifycenter()]
25. **Logs from `OSLogStore(scope: .currentProcessIdentifier)`**, read every 2 s off the main actor.
    The initializer throws; `currentProcessIdentifier` exists on iOS 15+ and macOS 12+.
    [read: https://developer.apple.com/documentation/oslog/oslogstore/init(scope:) and
    https://developer.apple.com/documentation/oslog/oslogstore/scope/currentprocessidentifier]
    Whether it returns this process's entries on iOS 27 in a Debug build is not known [guess G5].
26. **MetricKit payloads are stored as `jsonRepresentation()`.** Diagnostic payloads arrive
    immediately on iOS 15+ and macOS 12+; metric payloads at most once a day (on macOS only from
    macOS 26). [read: https://developer.apple.com/documentation/metrickit/mxmetricmanager,
    https://developer.apple.com/documentation/metrickit/mxmetricpayload/jsonrepresentation()]
    When they arrive in a Debug build is not known [guess G8].
27. **Shake marks use `CMMotionManager` accelerometer updates** at about 10 Hz, only while the app is
    active. CMMotionManager exists on iOS, iPadOS, Mac Catalyst, visionOS and watchOS — **not on
    macOS** — so the Mac uses the key ⌃⌥⌘M through `NSEvent.addLocalMonitorForEvents`.
    [read: https://developer.apple.com/documentation/coremotion/cmmotionmanager,
    https://developer.apple.com/documentation/appkit/nsevent/addlocalmonitorforevents(matching:handler:)]
    That accelerometer access needs no permission prompt is not checked [guess G7].
28. **The rendered screen** comes from `drawHierarchy(in:afterScreenUpdates:)` on iOS and
    `cacheDisplay(in:to:)` on macOS, and is labelled *rendered*. Apple notes `drawHierarchy` is
    slower than `snapshotView`. [read: https://developer.apple.com/documentation/uikit/uiview/drawhierarchy(in:afterscreenupdates:),
    https://developer.apple.com/documentation/appkit/nsview/cachedisplay(in:to:)]
    How much it differs from the real screen under Liquid Glass is not known [guess G4].
29. **The accessibility tree is recorded next to the view tree**, with the source of each node,
    because SwiftUI content may appear only there, or not at all, inside the app [guess G3].
    AppKit: `accessibilityChildren()` (macOS 10.10+).
    [read: https://developer.apple.com/documentation/appkit/nsaccessibilityprotocol/accessibilitychildren()]
30. **Hangs:** a watchdog thread pings the main queue every 50 ms and records stalls of 250 ms or
    more; it pauses while the app is inactive and resets when it becomes active. **Memory:**
    `phys_footprint` from `task_info(TASK_VM_INFO)` every 2 s. **Launch:** process start time from
    `sysctl(KERN_PROC_PID)` to the first `didBecomeActive`. [guess G6 for the watchdog's idle cost
    and false hangs; `task_vm_info` is a kernel header with no page in Apple's online docs — the doc
    request returned 404]

## 3. What was measured, and where

| When | Where | What |
|---|---|---|
| 4 Nov 2026 | Linux (the first build; no Swift toolchain there) | `server/` tests, the release-check logic on fake `.app` folders, the SHA-256 logic through a JavaScript port. |
| 4 Nov 2026 | Mac (macOS 27, Xcode 27.2) | First compile of the Swift; kit tests (`swift test`, 37); server tests; demo builds for iOS and macOS. |
| 4–5 Nov 2026 | Simulator (iPhone 17 Pro, iOS 26.5) | TESTING-ON-MAC steps 4, 5 and 7–11. |
| 5 Nov 2026 | iPhone 12 Pro (iOS 27.0.1), over Wi-Fi | Steps 12–16 and 18 (step 18 builds on the Mac). |

Every run is in docs/TEST-LOG.md. **Not measured yet:** step 6 (a session with the Mac app: G9, G15)
and step 17 (compare and evidence on two real recordings; the logic is tested with fixtures).

What the guesses in section 4 turned out to be:

| # | Result |
|---|---|
| G1 | Right. The app answered the Darwin notification after 0.5 s (simulator) and 1.3 s (phone). |
| G2 | Right. `copy from` put `hello.json` directly in the destination; a command copied to the inbox was answered within 3 s. |
| G3 | Measured (simulator and phone): the view tree has only UIKit hosting views for SwiftUI. SwiftUI builds its accessibility elements only while an assistive technology is attached: bare windows without one (1 on the simulator, 2 on the phone), 32 and 33 nodes with one, and every identifier then found. |
| G4 | Simulator: 2.2 % of pixels differ (1.2 % by more than 16/255). Phone: 17.2 % (2.1 %); the phone's capture can be 16-bit Display P3 while the rendering is 8-bit sRGB. See section 5 for a mark whose two pictures were a second apart. |
| G5 | Right on both: the app's `Logger` errors arrive in the timeline. |
| G6 | Right on the simulator: idle CPU 0.6–0.8 %, no false hang after the background. |
| G7 | Right: shaking the phone asked for no permission. |
| G8 | Open: no MetricKit payload arrived within 2 minutes after a crash. Crashes still come from systemCrashLogs. |
| G9, G15 | Not measured yet (step 6). |
| G10 | Right: simulator crash reports land in `~/Library/Logs/DiagnosticReports`, written up to 18 s after the crash. |
| G11 | Right: `passcodeRequired` (and `unlockedSinceBoot`); `bundleIdentifier`, `name`, `version`, `bundleVersion`; `result.files[].relativePath`. |
| G12 | Right. |
| G13 | Right: `properties.state.name` is the device's name. |
| G14 | Phone: the console shows devicectl's own lines and a Swift fatal error; `Logger` lines do not appear there (0 of 13). |

## 4. Guesses (each checked in docs/TESTING-ON-MAC.md)

The ten "measure first" unknowns of the brief are G1–G8, G14 and G15; G9–G13 are smaller guesses this build added.

| # | Guess | What happens if it is wrong | Checked in |
|---|---|---|---|
| G1 | A Darwin notification posted by `devicectl device notification post` (phone) or `simctl spawn … notifyutil -p` (simulator) reaches the app. | Commands arrive within 2 s through the inbox read. `doctor` says which path worked. | step 9, 13 |
| G2 | `copy from` with `--source "Library/Application Support/Fieldbook"` copies the folder, and `copy to` with `--destination "Library/Application Support/Fieldbook/inbox/<file>"` writes one file. | Pulls or commands fail with devicectl's message; the path form must change in `devices/phone.ts`. | step 12 |
| G3 | The in-app view tree sees UIKit hosting views for SwiftUI; the accessibility tree sees SwiftUI elements. | `find` may not find SwiftUI elements by identifier in one of the trees. **Measured** (simulator, iOS 26.5, 5 Nov 2026): the view tree has the hosting views only; SwiftUI builds its accessibility elements only while an assistive technology is attached (1 node without, 32 with), and its elements answer the identifier getter without declaring `UIAccessibilityIdentification`, so the kit asks every element that responds to it. `find id:pinnedBadge` then matches in the accessibility tree. | step 7 |
| G4 | The rendered screenshot looks like the real one, except for Liquid Glass effects. | Prefer `screen-captured.png`; the share of changed pixels is measured (`scripts/pixel-diff.ts`). | steps 8, 14 |
| G5 | `OSLogStore(scope: .currentProcessIdentifier)` returns this process's entries on iOS 27 in a Debug build. | No log events; a `problem` event says the store could not be read. | steps 10, 14 |
| G6 | The 50 ms watchdog costs near-zero CPU when idle and reports no false hang after returning from the background. | Overhead or false hangs; the interval or the reset needs a change. | step 11 |
| G7 | Accelerometer updates need no permission prompt. | A prompt appears; shake marks need user permission once. | step 14 |
| G8 | MetricKit delivers diagnostic payloads soon after a crash in a Debug build. | `metrickit/` stays empty; crash logs still come from systemCrashLogs. | step 16 |
| G9 | `NSWindow.windowNumber` is the window id `screencapture -l` takes. | The Mac capture shows the wrong window or none; the mark is still filed without it. | step 6 |
| G10 | Simulator app crash reports land in the Mac's `~/Library/Logs/DiagnosticReports`. | Simulator crash pickup finds nothing. | step 5 |
| G11 | `info lockState` has a boolean `passcodeRequired`; `info apps` lists `bundleIdentifier`, `name`, `version`, `bundleVersion` under `result.apps`; `info files` lists names under `relativePath`. | Lock state or app version shows as *missing*; the parser needs the real key. | step 12 |
| G12 | `simctl list devices --json` and `simctl launch --terminate-running-process` exist as used. (From simctl's help text.) | The simulator list or relaunch fails with simctl's message. | step 3 |
| G13 | `properties.state.name` in `devicectl list devices` is the device's name (as `deviceProperties.name` was). | A phone shows an odd name; reachability is not affected. | step 12 |
| G14 | `process launch --console` (and `simctl launch --console-pty`) shows the app's `print` output; whether `Logger` output appears there too is open. | Nothing breaks: logs come from OSLogStore (G5); `console.log` holds whatever the console shows. | steps 5, 15 |
| G15 | Reading a sandboxed Mac app's container from the server's process may bring up a macOS privacy prompt. | The first pull fails until the user allows it once; doctor's container item says so. | step 6 |

## 5. Known limits

Found on the phone or in review; each is open, not hidden.

- **A mark's two pictures are taken separately.** For a mark sent from the Mac, the app takes its
  snapshot when it reads the command, and `devicectl capture screenshot` runs at the same time. On
  the phone they were 1.1 s apart (snapshot 12:50:55.473Z, capture 12:50:56.536Z) and showed
  different scroll positions of the same list. The mark answer does not show that gap yet.
- **An empty accessibility tree is not a measurement.** Without VoiceOver or Accessibility
  Inspector a SwiftUI screen has no accessibility elements, so `find` in that tree finds nothing.
  The answer says "accessibility tree empty (missing: …)" instead of a count.
- **Memory is sampled every 2 s,** so a shorter peak can be missed.
- **Fieldbook costs a little.** Idle CPU was 0.6–0.8 % on the simulator. A snapshot takes 74–131 ms
  in the app, and its tree walks run on the main thread.
- **A comparison trusts its inputs.** `compare` assumes both sessions ran the same steps on the
  same kind of device. It shows both numbers for every rule but does not check that.
- **The first copy is still judged by the clocks.** What the first copy finds (on the phone the copy
  takes about 1 s) is compared with the Mac's start time, so with a phone clock several seconds
  behind, an event from that second can be left out. A log the kit read late is compared with the
  run's newest event before the start; after the app was suspended that event can be old, so a few
  late logs from before the start may show.
- **Colours are compared as stored.** `scripts/pixel-diff.ts` does no colour management; a Display P3
  capture and an sRGB rendering differ a little in saturated colours.
