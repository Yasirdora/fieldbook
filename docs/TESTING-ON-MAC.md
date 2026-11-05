# Testing Fieldbook on macOS

This checklist covers step-by-step verification of Fieldbook on macOS: building the Swift package,
running server tests, validating against simulator devices, and testing on real hardware.
Run the steps in order. Each step has the exact commands, what to look for, and a pass rule.

Order: the kit → the server → the demo on a **scratch simulator** → the **Mac app** → the **phone**.
The phone comes last, after confirming permissions to install the demo app.

Paths below assume the clone is at `~/Code/fieldbook` (a lower-case folder name; see step 18 why).
Set these once per terminal:

```bash
cd ~/Code/fieldbook
export FIELDBOOK_HOME="$HOME/Library/Application Support/Fieldbook"
```

Environment for testing: macOS, Xcode, Swift 6, devicectl.

---

## 1. Check the tools

```bash
xcodebuild -version
swift --version
xcrun devicectl --version
node --version
xcodegen --version
```

**Look for:** Xcode 27.2, Swift 6.4.2, devicectl 651.32, Node 22.18 or newer, any XcodeGen 2.x.
**Pass:** all five print a version. (Install XcodeGen with `brew install xcodegen` if it is missing.)

## 2. Build and test the kit

```bash
cd kit
swift build 2>&1 | tail -40
swift test 2>&1 | tail -40
xcodebuild -scheme FieldbookKit -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -20
cd ..
```

**Look for:** compile errors first — this code was never compiled. Then the Swift Testing summary
(`RedactionTests`, `FormatFixtureTests`, `MailboxTests`, `TreeWalkTests`, `JSONValueTests` and
`KitSourceRulesTests`). On a Mac, `swift build` also compiles FieldbookKit's AppKit half. The `xcodebuild` line compiles the UIKit half of FieldbookKit, which `swift build`
on a Mac does not reach.
**Pass:** both builds end without errors in Swift 6 language mode; every test passes. Fix compile
errors in place (small, clean fixes), and log each one in TEST-LOG.md.

## 3. The server: tests, MCP registration, doctor

```bash
cd server && npm ci && npm test 2>&1 | tail -5 && npm run typecheck && cd ..
node "$PWD/server/src/main.ts"
xcrun simctl help launch | grep -c terminate-running-process
xcrun simctl list devices --json | head -5
```

Then call the tool `doctor` with no arguments.

**Look for:** `ℹ pass` equal to `ℹ tests` (140 or more; Node 26 prints these lines); no output from `typecheck`. The `grep -c`
prints 1. `simctl list devices --json` prints JSON. In doctor: `✓ devicectl` and `✓ simctl`.
**Pass:** all of the above. This settles **G12**.
**Fallback for G12:** if `--terminate-running-process` does not exist, relaunch on a simulator fails
with simctl's message; start the app by hand and record without `relaunch`.

## 4. The demo on a scratch simulator (Debug)

```bash
xcodegen generate --spec demo/project.yml
UDID=$(xcrun simctl create "Sparrowpad Scratch" "iPhone 17")
xcrun simctl boot "$UDID"
xcodebuild -project demo/Sparrowpad.xcodeproj -scheme Sparrowpad-iOS -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath demo/DerivedData \
  FIELDBOOK_COMMIT=$(git rev-parse --short HEAD) build 2>&1 | tail -20
xcrun simctl install "$UDID" demo/DerivedData/Build/Products/Debug-iphonesimulator/Sparrowpad.app
xcrun simctl launch "$UDID" com.example.sparrowpad
sleep 5
BOX="$(xcrun simctl get_app_container "$UDID" com.example.sparrowpad data)/Library/Application Support/Fieldbook"
ls "$BOX"; cat "$BOX/hello.json"; tail -3 "$BOX/events.jsonl"
```

**Look for:** the app shows five invented notes. The mailbox holds `hello.json`, `events.jsonl`,
`inbox/`, `outbox/`, `snapshots/`, `metrickit/`; `kit-state.json` appears once the app has read its
first command (step 5). `hello.json` has `"redaction": "hashed"`,
`"commit"` equal to `git rev-parse --short HEAD`, `"isSimulator": true`. The events include `lifecycle`
`active` and one `launch` with a plausible `ms`.
**Pass:** all of the above. (Keep `$UDID` for the next steps; `xcrun simctl delete "$UDID"` at the end.)

## 5. A whole simulator session

Call `session_start` with
`{"target": "simulator", "device": "<UDID>", "bundleId": "com.example.sparrowpad", "label": "sim first run", "build": "<git short sha>", "change": "TEST-1", "relaunch": true}`.
In the app: tap **Freeze 400 ms**, **Use 50 MB** twice, **Log an error**. Call `mark {"session": "<id>", "name": "list"}`.
Open the note "Bike repair steps" (it is pinned). Call `mark {"session": "<id>", "name": "detail"}`.
(Shake marks cannot be tested here: the simulator has no accelerometer. Step 14 tests them on the phone.)
Tap **Show a sheet**, then `snapshot {"session": "<id>"}`. Tap **Done**, then **Crash**. Wait 10 s.
Call `session_stop {"session": "<id>"}`, then `timeline {"session": "<id>"}`.

```bash
S="$FIELDBOOK_HOME/sessions/<id>"
ls "$S" "$S/marks"/* "$S/crashes"
head -40 "$S/console.log"
ls ~/Library/Logs/DiagnosticReports | grep -i sparrowpad
```

**Look for in the timeline:** `launch … ms`; `hang` of about 400 ms; `log error [demo] Could not save
the garden plan …`; `mark 1 "list" (screen captured, tree … nodes, accessibility tree empty (missing: …))`
— SwiftUI builds no accessibility elements until an assistive technology is attached, see step 7; `mark 2
"detail" …`; a `snapshot`; a `crash log crashes/Sparrowpad-….ips` at the time of the crash. A crash
report can take 20 s or more to appear: when the console shows a fatal error, `session_stop` waits up to
45 s for it.
**Pass:** each of those lines is there; each mark folder has `tree.json`, `ax.json`, `state.json`,
`screen-rendered.png`, `screen-captured.png`; `state.json` shows `"pinnedCount": 2` and `"keptMegabytes": 100`;
`session_stop` says "1 new crash log". This settles **G10** (simulator crash reports land in
`~/Library/Logs/DiagnosticReports`) and the simulator half of **G14** (what the console shows).
**Fallback for G10:** if no crash log arrives, record where the `.ips` file went (`find ~/Library -name 'Sparrowpad*.ips' -mmin -10`) and change `hostCrashReportsDir` in `server/src/devices/mailboxFolder.ts`.

## 6. The Mac app

```bash
xcodebuild -project demo/Sparrowpad.xcodeproj -scheme Sparrowpad-macOS -configuration Debug \
  -destination "platform=macOS" -derivedDataPath demo/DerivedData \
  FIELDBOOK_COMMIT=$(git rev-parse --short HEAD) build 2>&1 | tail -20
open demo/DerivedData/Build/Products/Debug/Sparrowpad.app
ls "$HOME/Library/Containers/com.example.sparrowpad.mac/Data/Library/Application Support/Fieldbook"
```

Call `session_start {"target": "mac", "bundleId": "com.example.sparrowpad.mac", "label": "mac first run"}`.
**Watch the screen** while it starts: does macOS show a privacy prompt for reading another app's
container? Then `mark {"session": "<id>", "name": "window"}`. Then press **⌃⌥⌘M** in the app: a sheet
"What did you see?" appears; type `test note` and press Save. Call `session_stop`, then `timeline`.

**Look for:** `marks/1-window/screen-captured.png` shows the Sparrowpad window (only that window);
`marks/2-key/note.txt` holds `test note`.
**Pass:** both. Record the exact prompt text, or "no prompt" (**G15**), and whether the capture shows
the right window (**G9**).
**Fallback for G9:** if the capture is wrong or empty, the mark is still filed without it
(`screenCaptured` is *missing*, with the reason). Check `screencapture -l` with the number from
`jq '.windows[].number' marks/1-window/tree.json` by hand.
**Fallback for G15:** if a prompt appears, allow it once for the terminal that runs the server
(System Settings → Privacy & Security); doctor's container item then reads ✓.

## 7. What the trees see in SwiftUI (G3)

SwiftUI builds its accessibility elements only while an assistive technology is attached. Fieldbook
never changes a device's settings, so the tester turns this on and off. On a simulator (measured):

```bash
xcrun simctl spawn "$UDID" defaults write com.apple.Accessibility ApplicationAccessibilityEnabled -bool true
# … relaunch the app, record, then restore:
xcrun simctl spawn "$UDID" defaults write com.apple.Accessibility ApplicationAccessibilityEnabled -bool false
```

On a phone, VoiceOver or Accessibility Inspector (Xcode › Open Developer Tool) attached to the app should do
the same; step 14 measures it.

Use a simulator session recorded that way:

```text
find {"session": "<id>", "mark": "detail", "query": "id:pinnedBadge"}
find {"session": "<id>", "mark": "list", "query": "id:noteRow-n3"}
find {"session": "<id>", "mark": "detail", "query": "id:pinnedBadge", "inside": "id:noteTitle"}
find {"session": "<id>", "mark": "detail", "query": "type:_UIHostingView"}
```

```bash
jq '[.. | objects | select(has("source")) | .source] | group_by(.) | map({(.[0]): length}) | add' "$S/marks/2-detail/ax.json"
jq '.nodes, .truncated' "$S/marks/2-detail/tree.json" "$S/marks/2-detail/ax.json"
```

**Look for:** whether `pinnedBadge` is found in `tree`, in `accessibility`, or in both; how many
accessibility nodes come from `uikit.element` (SwiftUI) and how many from `uikit.view`.
**Pass:** the answers are recorded in DESIGN.md (G3). `find` must find `pinnedBadge` in at least one tree.
**Fallback:** if neither tree has it, search by label (`label:Pinned` only works with full text or
the exact text) and record that SwiftUI identifiers are not visible in-app on iOS 27.

## 8. Rendered versus captured screen (G4)

```bash
node scripts/pixel-diff.ts "$S/marks/2-detail/screen-rendered.png" "$S/marks/2-detail/screen-captured.png"
```

Repeat on the phone in step 14 (Liquid Glass renders fully only on real hardware).
**Look for:** the line `N % of pixels differ (M % by more than 16 of 255)`, and whether the sizes differ.
**Pass:** the numbers are recorded for the simulator and the phone. There is no threshold; the developer
decides which picture to trust. The default stays: prefer `screen-captured.png`.

## 9. The notification round trip on the simulator (G1, part 1)

The app must be running in the foreground.

```text
doctor {"bundleId": "com.example.sparrowpad", "target": "simulator", "device": "<UDID>"}
```

**Look for:** the item `simulator "Sparrowpad Scratch": notification round trip`. ✓ "answered through
the Darwin notification after X s", or ✗ "… answered through its 2 s inbox read".
**Pass:** the item is *measured* (✓ or ✗). Record which path worked and the time.
**Fallback:** ✗ is fine: commands still arrive within about 2 s through the inbox read.

## 10. Logs from OSLogStore (G5)

```text
timeline {"session": "<id from step 5>", "kinds": ["log", "problem"]}
```

**Look for:** `log error [demo] Could not save the garden plan: the shelf for seeds is full (test
error 318).` and no `problem in logs: …` line.
**Pass:** the error log is there on the simulator (and on the phone in step 14).
**Fallback:** if a `problem in logs` line says the store could not be opened, logs are missing for
that platform; the console (`console.log`, with `relaunch: true`) still has `print` output.

## 11. Overhead: idle CPU, false hangs, snapshot time (G6)

With the simulator app open and untouched:

```bash
PID=$(pgrep -f "Sparrowpad.app/Sparrowpad" | head -1)
top -l 13 -s 5 -pid "$PID" -stats pid,cpu | awk '$1 == "'"$PID"'" {print $2}' | tail -12
jq '.ms' "$S"/marks/*/snapshot.json "$S"/snapshots/*/snapshot.json
```

Then start a new session (`relaunch: false`), send the app to the background (Simulator → Device →
Home) for 30 s, bring it back, wait 10 s, `session_stop`, and `timeline {"kinds": ["hang", "lifecycle"]}`.
**Look for:** the CPU numbers while idle; the snapshot times; any `hang` right after `lifecycle active`.
**Pass:** idle CPU on average below 1 %; no hang reported within 2 s after returning from the
background; snapshot times recorded (target: under 150 ms on a normal screen — measure it again on
the phone in step 14).
**Fallback:** if idle CPU is high, the watchdog interval (50 ms) or the 2 s samplers are the first
suspects; if false hangs appear, the watchdog's reset on `didBecomeActive` needs a look.

---

## 12. The phone — confirmation

Confirm before installing: "Install the Sparrowpad Debug build on the device?"
Continue only after confirmation. Fieldbook itself never installs; install with
Xcode tools, as for any reviewed build. The phone must be unlocked and on the same Wi-Fi.

```bash
xcrun devicectl list devices
PHONE=<the identifier of the iPhone 12 Pro>
xcodebuild -project demo/Sparrowpad.xcodeproj -scheme Sparrowpad-iOS -configuration Debug \
  -destination "platform=iOS,id=<its UDID>" -derivedDataPath demo/DerivedData \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<your-team-id> \
  FIELDBOOK_COMMIT=$(git rev-parse --short HEAD) build 2>&1 | tail -20
```

Install it with Xcode (Product → Run) or with `xcrun devicectl device install app --device "$PHONE" demo/DerivedData/Build/Products/Debug-iphoneos/Sparrowpad.app`,
open it once, then:

```text
devices {"bundleId": "com.example.sparrowpad"}
doctor {"bundleId": "com.example.sparrowpad", "target": "phone"}
```

Check the path forms and JSON shapes by hand (**G2**, **G11**, **G13**):

```bash
rm -rf /tmp/fb-copy && mkdir /tmp/fb-copy
xcrun devicectl device copy from --device "$PHONE" --domain-type appDataContainer \
  --domain-identifier com.example.sparrowpad --source "Library/Application Support/Fieldbook" --destination /tmp/fb-copy
find /tmp/fb-copy -maxdepth 3 | head -20
printf '{"args":{},"formatVersion":1,"id":"manual-ping-1","name":"ping","sentAt":"2026-11-04T12:00:00.000Z","seq":999001}\n' > /tmp/999001-ping.json
xcrun devicectl device copy to --device "$PHONE" --domain-type appDataContainer \
  --domain-identifier com.example.sparrowpad --source /tmp/999001-ping.json \
  --destination "Library/Application Support/Fieldbook/inbox/999001-ping.json"
xcrun devicectl device info lockState --device "$PHONE" --json-output /tmp/lock.json && jq .result /tmp/lock.json
xcrun devicectl device info apps --device "$PHONE" --require-container-access --json-output /tmp/apps.json && jq '.result.apps[0]' /tmp/apps.json
xcrun devicectl device info files --device "$PHONE" --domain-type systemCrashLogs --json-output /tmp/files.json && jq '.result | keys' /tmp/files.json
xcrun devicectl list devices --json-output /tmp/devices.json && jq '.result.devices[] | {identifier, state: .properties.state}' /tmp/devices.json
```

**Look for:** `copy from` makes a folder with `hello.json` (directly in `/tmp/fb-copy`, or inside
`/tmp/fb-copy/Fieldbook`); `copy to` succeeds and, within about 2 s, the app writes an outbox item
with `"commandId": "manual-ping-1"`. The lock JSON has a boolean `passcodeRequired`; the apps JSON has
`bundleIdentifier`, `name`, `version`, `bundleVersion`; the files JSON lists `.ips` names under
`relativePath`; `properties.state.name` is the phone's name.
**Pass:** `devices` shows the phone reachable, unlocked, and `com.example.sparrowpad: installed with
container access, version 1.0 (1)`; doctor's container access is ✓. Each shape matches, or the
parser keys are fixed (`server/src/devices/devicectl.ts`) with a test using the real (anonymised) JSON.
**Fallback for G2:** if a path form fails, the session's first pull reports devicectl's message;
change `MAILBOX_PATH`/`INBOX_PATH` use in `server/src/devices/phone.ts` to the form that worked.

## 13. The notification round trip on the phone (G1, part 2)

The doctor call in step 12 already ran it. **Look for:** `phone "<name>": notification round trip`.
**Pass:** *measured* ✓ or ✗; record which path and the time. **Fallback:** the 2 s inbox read.

## 14. A phone session, with a shake (G7)

`session_start {"target": "phone", "bundleId": "com.example.sparrowpad", "label": "phone first run", "relaunch": true}`.
On the phone: **Freeze 400 ms**, **Use 50 MB**, **Log an error**, open a pinned note, then **shake the
phone**. The sheet "What did you see?" appears; type `badge looks right`, Save. Then
`mark {"name": "detail"}` from the Mac. `session_stop`, `timeline`.

**Look for:** did iOS ask for any permission when shaking? A `mark … (shake)` with
`note on mark …: "badge looks right"`; `mark … "detail" (screen captured …)` with a capture taken by
`devicectl capture screenshot`. Then run steps 8 and 10 on this session, and the snapshot time:
`jq .ms "$FIELDBOOK_HOME"/sessions/<id>/marks/*/snapshot.json`.
Then attach Accessibility Inspector to the app (or turn on VoiceOver), take `mark {"name": "with inspector"}`,
and run step 7's `find` on that mark.
**Pass:** no permission prompt (**G7**); both marks filed; snapshot time under 150 ms; the accessibility
count of each mark is recorded (empty without an assistive technology, elements with one).
**Fallback for G7:** if a prompt appears, the user allows it once; ⌃⌥⌘M is the Mac's way, and the
Mac's `mark` tool always works.

## 15. What the console shows (G14)

```bash
cat "$FIELDBOOK_HOME/sessions/<id from step 14>/console.log"
```

**Look for:** the app's `print` lines (if any), and whether the `Logger` error from "Log an error"
appears there too.
**Pass:** recorded in DESIGN.md (G14). Logger output is expected in the timeline either way (step 10).

## 16. MetricKit in a Debug build (G8)

On the phone: tap **Crash**, then open the app again from the home screen and leave it in the
foreground for 2 minutes. Start a session (`relaunch: false`), wait a minute, stop it.

```bash
ls "$FIELDBOOK_HOME/sessions/<id>/metrickit"
```

**Look for:** a `…-diagnostics.json` file, and when it arrived (its name starts with the time in ms).
**Pass:** recorded either way (it may take until a later launch, or up to a day). The crash itself
must show in `crashes/` of the session that saw it (systemCrashLogs) — that path does not depend on MetricKit.

## 17. Compare two sessions and write evidence

Record two sessions on the phone (or the scratch simulator), each with `relaunch: true` so both have
a launch time. "before": tap **Freeze 400 ms** once, open "Bike repair steps", `mark {"name": "detail"}`.
"after": the same steps, but **Freeze 400 ms** three times, and **Use 50 MB** three times before the
mark. Then:

```text
compare {"a": "<before id>", "b": "<after id>"}
evidence {"comparison": "<comparison id>"}
```

```bash
E="$FIELDBOOK_HOME/comparisons/<comparison id>/evidence.json"
jq -r '.line' "$E"
cd "$FIELDBOOK_HOME" && jq -r '.files[] | "\(.sha256)  \(.path)"' "$E" | shasum -a 256 -c | tail -3; cd -
```

**Look for:** `fail … Peak memory` (150 MB more), `fail … Hangs of 250 ms or more: a 1, b 3` (3 > 1 + 1),
`Mark "detail": …` compared, `jq` printing the one-line summary, and every `shasum` line `OK`.
**Pass:** each rule shows both numbers and a verdict; no overall score; all hashes OK.

## 18. Release builds are clean

```bash
xcodebuild -project demo/Sparrowpad.xcodeproj -scheme Sparrowpad-iOS -configuration Release \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath demo/DerivedData build 2>&1 | tail -3
xcodebuild -project demo/Sparrowpad.xcodeproj -scheme Sparrowpad-macOS -configuration Release \
  -destination "platform=macOS" -derivedDataPath demo/DerivedData build 2>&1 | tail -3
scripts/check-release-clean.sh demo/DerivedData/Build/Products/Release-iphonesimulator/Sparrowpad.app
scripts/check-release-clean.sh demo/DerivedData/Build/Products/Release/Sparrowpad.app
scripts/check-release-clean.sh demo/DerivedData/Build/Products/Debug/Sparrowpad.app; echo "exit $?"
```

**Look for:** both Release checks end with `Clean: no part of Fieldbook found.`; the Debug check (a
control) ends with `NOT clean` and `exit 1`.
**Pass:** exactly that. If a Release check finds `Fieldbook` only in a source path (an unstripped
build keeps file paths), check that the clone's folder name has no capital-F "Fieldbook", or check a
stripped copy (`xcrun strip -S -o /tmp/stripped <binary>`), as `demo/README.md` explains.

## 19. Write it down

- docs/TEST-LOG.md: every command above with its result (counts, times, percentages).
- docs/DESIGN.md: move each settled guess (G1–G15) out of the guess table into the decisions, marked
  *measured* with the step number.
- Commit on a branch and push.
