# Sparrowpad (demo app)

Sparrowpad is a small SwiftUI app for iOS and macOS. It has a few made-up notes and some test buttons. We use it to prove each feature of the debug kit.

The app's own names do not contain the kit's name. The release check searches the Release app for that word, so it must find nothing there.

| | iOS | macOS |
|---|---|---|
| Target and scheme | `Sparrowpad-iOS` | `Sparrowpad-macOS` |
| Product name | `Sparrowpad` | `Sparrowpad` |
| Bundle id | `com.example.sparrowpad` | `com.example.sparrowpad.mac` |
| Sandbox | (always, on iOS) | yes, `Config/Sparrowpad-macOS.entitlements` |

Both targets use the same source folder, `Sparrowpad/`. Deployment target: iOS 26.0 and macOS 26.0. Swift 6 language mode, strict concurrency `complete`.

## Make the Xcode project

Run this from the repository root (you need [XcodeGen](https://github.com/yonaskolb/XcodeGen)):

```sh
xcodegen generate --spec demo/project.yml
```

This writes `demo/Sparrowpad.xcodeproj`. Git ignores it. Make it again after each pull.

## How the kit is linked in Debug only

Xcode cannot link a Swift package product in Debug only. So the project builds the kit itself:

1. `project.yml` has four framework targets: `FieldbookCore-iOS`, `FieldbookKit-iOS`, `FieldbookCore-macOS` and `FieldbookKit-macOS`. They compile the files in `../kit/Sources`. Each one is a **static** framework (`MACH_O_TYPE = staticlib`) named `FieldbookCore` or `FieldbookKit`.
2. Each app target depends on the two kit targets of its platform with `link: false` and `embed: false`. This only makes Xcode build the kit first. Nothing is linked, and nothing is copied into the app.
3. Only the **Debug** configuration of the app has `OTHER_LDFLAGS = -framework FieldbookKit -framework FieldbookCore`. So only a Debug build links the kit.
4. Every line of Swift that uses the kit is inside `#if DEBUG` (see `Sparrowpad/SparrowpadApp.swift`). A Release build never imports the kit.
5. Only the **Debug** configuration sets `INFOPLIST_FILE = Config/Debug-Info.plist`. Xcode merges this file into the generated Info.plist. It adds one key: `FieldbookCommit = $(FIELDBOOK_COMMIT)`. The build setting `FIELDBOOK_COMMIT` is `unknown` unless you pass a value. Release has no such key.

A Release build still compiles the kit targets, because the app depends on them. That is fine: the Release app does not link them, and does not copy them.

## The screens and what each button proves

The first screen is the note list. Below the notes is a **Tests** section with the buttons.

| What | Accessibility identifier | What it proves |
|---|---|---|
| Note rows | `noteRow-n1` … `noteRow-n5` | `find` works on list rows. Tap a row to open the note. |
| Pinned badge in the note | `pinnedBadge` | `find` works in the detail screen. Notes `n1` and `n3` start pinned. |
| Pin / Unpin button | `pinButton` | The badge comes and goes; `pinnedCount` in the state changes. |
| Note title and text | `noteTitle`, `noteBody` | Text is redacted (length and hash) unless the app runs with `-FieldbookText full`. |
| **Show a sheet** | `showSheetButton` | A snapshot sees a sheet on top. Inside: `sheetMessage`, `sheetDoneButton`. `sheetShown` is `true` in the state. |
| **Freeze 400 ms** | `freezeButton` | Blocks the main thread for 400 ms. Expect one `hang` event of about 400 ms (the threshold is 250 ms). |
| **Use 50 MB** | `useMemoryButton` | Each tap **adds** 50 MB more and keeps it. Every byte is written, so it counts. Expect `memory` events where `footprint` and `peak` go up by about 50 MB per tap. |
| **Free memory** | `freeMemoryButton` | Lets go of all the kept memory. `footprint` goes down; `peak` stays. `keptMemoryLabel` shows how much is kept. |
| **Log an error** | `logErrorButton` | Writes one `os.Logger` error: subsystem = bundle id, category `demo`, message `Could not save the garden plan: the shelf for seeds is full (test error 318).` Expect one `log` event with level `error`. |
| **Crash** (Debug only) | `crashButton` | Calls `fatalError`. The system writes a crash report, and the Mac picks it up. Start the app **without** the debugger, or the debugger catches the crash and no report is written. |

## The app's state

In Debug, the app starts the kit at launch and reports one state provider, `editor`:

```json
{ "keptMegabytes": 100, "noteCount": 5, "pinnedCount": 2, "selectedNote": "n3", "sheetShown": false }
```

`selectedNote` is `null` when no note is open. (The kit writes the keys in sorted order.)

## Build and run

Run all commands from the repository root. `demo/DerivedData` is ignored by Git.

### iOS, on a scratch simulator

Make a new simulator, so your other simulators stay as they are. (`xcrun simctl list devicetypes` shows the device names you can use.)

```sh
UDID=$(xcrun simctl create "Sparrowpad Scratch" "iPhone 17")
xcrun simctl boot "$UDID"
```

Debug:

```sh
xcodebuild -project demo/Sparrowpad.xcodeproj -scheme Sparrowpad-iOS \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath demo/DerivedData \
  FIELDBOOK_COMMIT=$(git rev-parse --short HEAD) \
  build
xcrun simctl install "$UDID" demo/DerivedData/Build/Products/Debug-iphonesimulator/Sparrowpad.app
xcrun simctl launch "$UDID" com.example.sparrowpad
```

To keep the text of views in snapshots (not only length and hash), launch with the kit's argument:

```sh
xcrun simctl terminate "$UDID" com.example.sparrowpad
xcrun simctl launch "$UDID" com.example.sparrowpad -FieldbookText full
```

Release:

```sh
xcodebuild -project demo/Sparrowpad.xcodeproj -scheme Sparrowpad-iOS \
  -configuration Release \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath demo/DerivedData \
  build
```

The mailbox on the simulator:

```sh
echo "$(xcrun simctl get_app_container "$UDID" com.example.sparrowpad data)/Library/Application Support/Fieldbook"
```

When you are done: `xcrun simctl delete "$UDID"`.

### macOS

Debug:

```sh
xcodebuild -project demo/Sparrowpad.xcodeproj -scheme Sparrowpad-macOS \
  -configuration Debug \
  -destination "platform=macOS" \
  -derivedDataPath demo/DerivedData \
  FIELDBOOK_COMMIT=$(git rev-parse --short HEAD) \
  build
open demo/DerivedData/Build/Products/Debug/Sparrowpad.app
```

With full text (quit the app first): `open demo/DerivedData/Build/Products/Debug/Sparrowpad.app --args -FieldbookText full`.

Release:

```sh
xcodebuild -project demo/Sparrowpad.xcodeproj -scheme Sparrowpad-macOS \
  -configuration Release \
  -destination "platform=macOS" \
  -derivedDataPath demo/DerivedData \
  build
```

The Mac app is signed to run locally (`CODE_SIGN_IDENTITY = -`), so no team is needed. It is sandboxed, so the mailbox is here:

```
~/Library/Containers/com.example.sparrowpad.mac/Data/Library/Application Support/Fieldbook/
```

## Check that Release is clean

The search is case-sensitive. It must print nothing:

```sh
grep -rl Fieldbook demo/DerivedData/Build/Products/Release-iphonesimulator/Sparrowpad.app
grep -rl Fieldbook demo/DerivedData/Build/Products/Release/Sparrowpad.app
```

The Info.plist key must be missing in Release (this command must fail):

```sh
/usr/libexec/PlistBuddy -c "Print :FieldbookCommit" demo/DerivedData/Build/Products/Release-iphonesimulator/Sparrowpad.app/Info.plist
```

And present in Debug:

```sh
/usr/libexec/PlistBuddy -c "Print :FieldbookCommit" demo/DerivedData/Build/Products/Debug-iphonesimulator/Sparrowpad.app/Info.plist
```

On the Mac the file is `Sparrowpad.app/Contents/Info.plist` (in `Release/` and `Debug/`).

One thing to know: a Release build made with `xcodebuild build` is not stripped. Its binary still holds the paths of the source files, for the debugger. If the folder of your clone has `Fieldbook` (with a capital F) in its path, the search finds that path, not kit code. Then search a stripped copy instead:

```sh
xcrun strip -S -o /tmp/Sparrowpad-stripped demo/DerivedData/Build/Products/Release/Sparrowpad.app/Contents/MacOS/Sparrowpad
grep -c Fieldbook /tmp/Sparrowpad-stripped
```

## Files

- `project.yml`: the XcodeGen project.
- `Config/Debug-Info.plist`: the one Info.plist key for Debug builds.
- `Config/Sparrowpad-macOS.entitlements`: turns on the App Sandbox for the Mac app.
- `Sparrowpad/`: the SwiftUI code for both apps. All notes are invented.
