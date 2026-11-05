# Fieldbook

Fieldbook provides runtime observability for iOS and macOS Debug builds via an MCP server and in-app probe (`FieldbookKit`).

When testing an app on an iPhone, a simulator, or the Mac, problems often appear only there:
speed, memory, gestures, Liquid Glass rendering, the camera. Without Fieldbook you describe
them in words and guess the cause. With Fieldbook, while testing the Debug build, Fieldbook
records:

- what the app logged, crashes, memory use, main-thread hangs (moments when the screen freezes)
  and launch time;
- at the moments the tester marks (shake the phone, or ⌃⌥⌘M on the Mac): a real screenshot, the
  tree of views and accessibility elements with their frames, and the app's own state.

Each recording is filed under the build and the change that made it. Two recordings of the same
steps — before and after a change — can be compared with clear pass and fail rules. A small
`evidence.json` lets a [Code Director](https://github.com/Yasirdora/CodeDirector) Change Report cite
the result. That link is optional: Fieldbook works on its own.

**Platforms.** iOS 26+ and macOS 26+ (AppKit). Mac Catalyst is not supported.

**Tested on** a real iPhone 12 Pro (iOS 27.0.1), an iPhone 17 Pro simulator (iOS 26.5) and a Mac with
Xcode 27.2, in November 2026. What was measured, and what is still open, is in docs/DESIGN.md
(sections 3 and 5); every test run is in docs/TEST-LOG.md.

**What it is not.** Not a tool for other people's apps, and not a planning method. It observes your
own Debug builds, from source, with the tester's consent. It never installs, uninstalls, erases or
reboots anything, never changes device settings, and has no upload feature. See docs/SAFETY.md.

## The parts

| Folder | What | Runs on |
|---|---|---|
| `kit/` | Swift package. **FieldbookCore**: the formats and the mailbox (platform-neutral). **FieldbookKit**: the probe inside the app (UIKit on iOS, AppKit on macOS), Debug builds only. | the app |
| `server/` | The Fieldbook MCP server (TypeScript, Node 22.18+). Talks to devices only through `devicectl`, `simctl`, `notifyutil`, `screencapture` and files. | the Mac |
| `demo/` | "Sparrowpad", a small SwiftUI demo app (iOS and macOS) with buttons that prove each feature. | phone, simulator, Mac |
| `scripts/check-release-clean.sh` | Fails if a Release build still contains any part of Fieldbook. | the Mac |
| `docs/` | FORMAT (the files), DESIGN (decisions and what is measured), SAFETY, TESTING-ON-MAC (verification guide), CODE-DIRECTOR-LINK, TEST-LOG. | — |

The app and the Mac never talk over the network. The app writes a *mailbox* folder in its own data
container; the Mac copies it out and drops command files in, then signals the app with a Darwin
notification (a system-wide signal with a name and no data).

## Quick start (on the Mac)

1. **The server.**

   ```bash
   cd server && npm ci && npm test
   ```

   Then register it with your MCP client as a stdio server. Most clients read a configuration
   like this one:

   ```json
   {
     "mcpServers": {
       "fieldbook": { "command": "node", "args": ["/absolute/path/to/fieldbook/server/src/main.ts"] }
     }
   }
   ```

2. **The kit in your app.** Add `kit/` as a local Swift package and link `FieldbookKit` in the
   **Debug** configuration only (the demo shows one way: `demo/README.md`). Then, at launch:

   ```swift
   #if DEBUG
   import FieldbookKit
   #endif

   // in your App's init
   #if DEBUG
   Fieldbook.start()
   Fieldbook.state("editor") { ["page": 12, "selectedNote": "n3"] }
   #endif
   ```

   Optional: add `FieldbookCommit = $(FIELDBOOK_COMMIT)` to the Info.plist so recordings know the commit.

3. **Record.** Call the MCP tools directly or from your MCP client:

   - `devices` — what is connected; `doctor` — what works right now;
   - `session_start {target: "simulator", bundleId: "com.example.sparrowpad", label: "before fix", relaunch: true}`;
   - use the app; `mark {session, name: "pin on the wrong page"}` at a moment that matters (or shake the phone);
   - `session_stop {session}`, then `timeline {session}` and `find {session, mark: "1", query: "id:pinnedBadge"}`;
   - record the same steps after the change, then `compare {a, b}` and `evidence {comparison}`.

4. **Before shipping:** `scripts/check-release-clean.sh path/to/Release/App.app`.

Sessions are stored in `$FIELDBOOK_HOME/sessions/<id>/` (default `~/Library/Application Support/Fieldbook`).

## Tools

| Tool | What it does |
|---|---|
| `devices` | Phones, simulators and this Mac: reachable, locked, app installed with container access. |
| `doctor` | What works right now; each item measured or missing. |
| `session_start` / `session_stop` | Record a session; relaunch only when asked; crash logs at the end, waiting for a late report after a fatal error. |
| `mark` / `snapshot` | A moment with a real screenshot and the app's snapshot. |
| `timeline` | Short text: `00:12.4 mark 3 "pin on the wrong page" (screen captured, tree 412 nodes)`. System log lines below error level are left out unless asked for. |
| `find` | Elements by id, label, type, text or text hash; "is A inside B"; distance in points. |
| `compare` | Two sessions; each rule shows both numbers and pass, warn, fail or unchecked. |
| `evidence` | Writes `evidence.json` for [Code Director](https://github.com/Yasirdora/CodeDirector). |

Every value carries an evidence label: **measured**, **captured** (a real screenshot), **rendered**
(drawn by the app), **reported** (the app's own words) or **missing** (with the reason).

## Licence

MIT. See [LICENSE](LICENSE).
