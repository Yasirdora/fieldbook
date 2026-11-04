# Fieldbook formats (format version 1)

This file defines every file Fieldbook writes. Two programs share these files:

- **the kit**: the Swift code inside the app (`kit/`), which writes the *mailbox*;
- **the server**: the TypeScript MCP server on the Mac (`server/`), which copies the mailbox and writes *sessions*.

Shared test files for the formats are in `fixtures/format-v1/`. The Swift tests and the TypeScript tests both read them, so both sides stay in step.

## Rules for every file

- Text is UTF-8. JSON keys are written in sorted order.
- Every JSON file has `"formatVersion": 1` at the top level. Every event line has it too.
- A reader accepts files with the same `formatVersion`. It ignores fields it does not know. A higher version means a breaking change: the reader stops and says so.
- An optional field is either `null` or missing; readers treat both the same. The kit writes `null`
  in hello.json, outbox items, snapshot.json and window entries, and leaves optional fields out of
  view and accessibility nodes (to keep big trees small).
- Times are ISO 8601 in UTC with milliseconds: `2026-11-04T10:15:02.123Z`.
- Sizes and positions are in **points**, the unit iOS and macOS use for layout (not pixels).
- A *rect* is `{"x": 0, "y": 0, "w": 390, "h": 844}`. The origin is top left.
- Files are written **atomically**: first to a temporary file in the same folder (name starts with `.`), then renamed. A reader never sees half a file. Readers skip names that start with `.`.
- `events.jsonl` is the one exception: lines are appended. A reader ignores a last line that has no line break at its end (it may still be in the middle of being written).

## Redacted text

Text the app shows on screen can be private. By default the kit never stores it. It stores this instead:

```json
{ "length": 12, "sha256_8": "1a2b3c4d" }
```

- `length` is the number of Unicode scalars (code points) in the text.
- `sha256_8` is the first 8 hex characters (lower case) of the SHA-256 hash of the text's UTF-8 bytes. A hash is a short fingerprint: the same text always gives the same fingerprint, but the text cannot be read back from it.

When the app was launched with the argument `-FieldbookText full`, the kit adds the text itself:

```json
{ "length": 12, "sha256_8": "1a2b3c4d", "text": "Pinned notes" }
```

The hash is always there, so a recording in one mode can be compared with a recording in the other mode.

Rules:

- View text, accessibility labels, accessibility values and window titles are redacted.
- Accessibility **identifiers** are not redacted. Developers set them in code; they are not user content.
- Log messages are kept as text, cut to 500 characters. (A log message is written by the developer's code. The cut keeps big dumps out.)
- The tester's own note on a mark ("What did you see?") is kept as text. The tester writes it on purpose.

## The mailbox (written by the kit, inside the app)

The mailbox is a folder in the app's own data container:

| App kind | Mailbox folder |
|---|---|
| iOS app on a phone or a simulator | `<data container>/Library/Application Support/Fieldbook/` |
| Sandboxed macOS app | `~/Library/Containers/<bundle id>/Data/Library/Application Support/Fieldbook/` |
| macOS app without sandbox | `~/Library/Application Support/Fieldbook/mailbox/<bundle id>/` |

The folder is marked "do not back up" (`isExcludedFromBackup`).

```
Fieldbook/
  hello.json
  events.jsonl
  events.1.jsonl          (older events, after rotation)
  kit-state.json          (the kit's own counters; the Mac ignores it)
  snapshots/<snapshot id>/
    snapshot.json
    tree.json
    ax.json
    state.json
    screen-rendered.png
  metrickit/<ms>-<n>-<type>.json
  inbox/<seq>-<name>.json   (commands from the Mac)
  outbox/<seq>-<kind>.json  (results for the Mac)
```

### hello.json

Written once at each app launch, replacing the old one.

```json
{
  "formatVersion": 1,
  "probeVersion": "0.1.0",
  "runId": "5C1E0A2B-7D4F-4B8A-9E61-0F3D2C1B0A99",
  "bundleId": "com.example.fieldbook.demo",
  "appName": "Fieldbook Demo",
  "executable": "FieldbookDemo",
  "appVersion": "1.0",
  "appBuild": "7",
  "commit": "a1b2c3d",
  "deviceModel": "iPhone13,3",
  "platform": "iOS",
  "isSimulator": false,
  "osVersion": "27.0.1",
  "pid": 4242,
  "processStart": "2026-11-04T10:15:00.000Z",
  "redaction": "hashed",
  "hangThresholdMs": 250,
  "writtenAt": "2026-11-04T10:15:00.390Z"
}
```

- `runId` is new at every launch. It tells two launches apart.
- `commit` comes from the key `FieldbookCommit` in the app's Info.plist. It is `null` when the key is missing.
- `redaction` is `"hashed"` or `"full"`: the mode the kit really uses (an app can set it in code,
  which wins over the launch argument).
- `hangThresholdMs` is the threshold in use, between 1 ms and 1 hour.

### events.jsonl

One event per line. Every event has the same envelope, and one payload under a key named like its `kind`:

```json
{"formatVersion":1,"kind":"hang","hang":{"ms":412,"start":"2026-11-04T10:15:07.100Z"},"runId":"5C1E…","seq":9,"time":"2026-11-04T10:15:07.512Z"}
```

- `seq` counts up from 1 in each run. `runId` + `seq` identifies an event.
- `time` is the device clock when the event was written.

| kind | payload | meaning |
|---|---|---|
| `launch` | `{"ms": 412}` | From process start to the first time the app became active. A launch that iOS prewarmed (`ActivePrewarm=1`) is not a real launch time; the kit records a `problem` with `where: "launch"` instead. |
| `lifecycle` | `{"state": "active"}` | `active`, `inactive` or `background`. |
| `log` | `{"level", "subsystem", "category", "message", "cut", "logTime"}` | One log entry of this process. `level` is `undefined`, `debug`, `info`, `notice`, `error` or `fault`. `cut` is true when the message was longer than 500 characters. |
| `hang` | `{"start": time, "ms": 412}` | The main thread did not answer for `ms` milliseconds (only stalls of at least `hangThresholdMs`). |
| `memory` | `{"footprint": bytes, "peak": bytes}` | `phys_footprint` of the process, and the highest value seen in this run. |
| `mark` | `{"id", "number", "name", "source", "snapshotId", "commandId"}` | A tester marked a moment. `source` is `shake`, `key` or `command`. `name` and `commandId` are optional. |
| `note` | `{"markId", "text"}` | What the tester typed in the "What did you see?" sheet. |
| `snapshot` | `{"id", "reason", "ms", "nodes", "axNodes", "truncated"}` | A snapshot was stored. `reason` is `mark` or `command`. |
| `command` | `{"id", "name", "via"}` | The app read a command. `via` is `notification` or `poll`. |
| `metrickit` | `{"file", "type"}` | MetricKit delivered a payload. `type` is `metrics` or `diagnostics`. |
| `problem` | `{"where", "message"}` | Something inside Fieldbook went wrong. The app goes on. |

**Rotation.** Before a write would make `events.jsonl` bigger than 5 MB (5 × 1024 × 1024 bytes), the kit renames it to `events.1.jsonl` (replacing the older one) and starts a new `events.jsonl`. At most 2 files exist.

### Snapshots

A snapshot is a picture of the app at one moment: its views, its accessibility elements, its own state and a rendered image.

Snapshot ids look like `5c1e0a2b-0004`: the first 8 characters of the run id, then a counter.

`snapshot.json` (`tree` and `ax` are `null` when that part was not taken):

```json
{
  "formatVersion": 1,
  "id": "5c1e0a2b-0004",
  "time": "2026-11-04T10:15:12.400Z",
  "reason": "mark",
  "markId": "5c1e0a2b-m3",
  "commandId": null,
  "ms": 84,
  "parts": ["tree", "ax", "state", "rendered"],
  "tree": { "nodes": 412, "truncated": false },
  "ax": { "nodes": 85, "truncated": false },
  "problems": []
}
```

`tree.json`: the view tree. The walk stops at 5000 nodes; then `truncated` is true.

```json
{
  "formatVersion": 1,
  "limit": 5000,
  "nodes": 3,
  "truncated": false,
  "windows": [
    {
      "index": 0,
      "number": null,
      "isKey": true,
      "title": null,
      "frame": { "x": 0, "y": 0, "w": 390, "h": 844 },
      "root": { "type": "UIWindow", "frame": {…}, "window": 0, "hidden": false, "alpha": 1, "interactive": true, "children": [ … ] }
    }
  ]
}
```

A view node (type names drop generic arguments, for example `_UIHostingView`; frames are rounded to
1/100 point, and a frame that is not a finite number is written as 0; password fields give no text and
no accessibility value):

| field | meaning |
|---|---|
| `type` | The Swift type name, for example `UILabel`. |
| `frame` | Position and size in **window** points. |
| `window` | Index of the window in `windows`. |
| `hidden`, `alpha` | `isHidden` and `alpha` (`alphaValue` on macOS). |
| `interactive` | Whether the view takes touches or clicks (`isUserInteractionEnabled` on iOS; on macOS always `true`, because AppKit has no such flag). |
| `ax` | Optional: `{"id", "label", "value", "traits"}`. `id` is plain text. `label` and `value` are redacted text. `traits` is a list such as `["button", "selected"]`. |
| `text` | Optional: the view's own text, redacted. |
| `scroll` | Optional, for scroll views: `{"offset": {"x", "y"}, "content": {"w", "h"}}`. |
| `children` | The subviews, front-most last. |

`number` in a window is the macOS window number (`NSWindow.windowNumber`). The Mac uses it to capture just that window. It is `null` on iOS.

`ax.json`: what VoiceOver can reach, with the same window list. Password fields give no `value` here either. An accessibility node has `source`, `type`, `frame` (window points), optional `id`, `label`, `value`, `traits`, and `children`. `source` says where the node came from:

| source | meaning |
|---|---|
| `uikit.view` | A UIKit view that is an accessibility element. |
| `uikit.element` | An object from `accessibilityElements` (often SwiftUI content). |
| `appkit.children` | An object from `accessibilityChildren()` on macOS. |

`state.json`: the app's own state, as the app reported it.

```json
{
  "formatVersion": 1,
  "time": "2026-11-04T10:15:12.410Z",
  "providers": { "editor": { "page": 12, "selectedNote": "n3" } },
  "problems": {}
}
```

`screen-rendered.png`: the app drew its own windows into an image (`drawHierarchy` on iOS, `cacheDisplay` on macOS). It is labelled **rendered**. It can differ from what the screen showed, for example under Liquid Glass. The Mac prefers a real capture.

### Commands: `inbox/<seq>-<name>.json`

The Mac writes commands; the app reads them. `seq` is written with 6 digits, for example `000007-mark.json`.

```json
{
  "formatVersion": 1,
  "id": "20261104-101500-demo-a1b2-7",
  "seq": 7,
  "name": "mark",
  "sentAt": "2026-11-04T10:15:12.300Z",
  "args": { "name": "pin on the wrong page", "ask": false }
}
```

| name | args | what the app does |
|---|---|---|
| `mark` | `name`, `ask` | Takes a snapshot and records a mark. When `ask` is true it also shows the "What did you see?" sheet. |
| `snapshot` | `parts` (list of `tree`, `ax`, `state`, `rendered`) | Takes a snapshot. |
| `ping` | none | Answers at once. Used to measure the notification round trip. |
| `ack` | `upTo` | The Mac has copied every outbox item up to this number. The app deletes them. |

After the Mac copies a command file into `inbox/`, it posts the Darwin notification `fieldbook.<bundle id>.inbox`. (A Darwin notification is a system-wide signal with a name and no data. It works across processes on the same device.) The app also reads the inbox every 2 seconds while it is active, in case the notification does not arrive.

The app deletes each command file after it reads it. The Mac never deletes files in the app's container. The app keeps the ids of the last 100 commands, so a command that arrives twice runs once.

### Results: `outbox/<seq>-<kind>.json`

The app writes one outbox item for each thing it made for the Mac. The app counts `seq` up across runs (the counter is in `kit-state.json`).

```json
{
  "formatVersion": 1,
  "seq": 4,
  "runId": "5C1E0A2B-7D4F-4B8A-9E61-0F3D2C1B0A99",
  "time": "2026-11-04T10:15:12.500Z",
  "kind": "mark",
  "commandId": "20261104-101500-demo-a1b2-7",
  "commandName": "mark",
  "via": "notification",
  "ok": true,
  "message": null,
  "snapshotId": "5c1e0a2b-0004",
  "markId": "5c1e0a2b-m3",
  "file": null
}
```

`kind` is `result` (answer to a command), `mark` (a mark, from any source) or `metrickit` (a MetricKit file in `file`).
When a mark's snapshot could not be stored, its outbox item has `"snapshotId": null`, while the mark
event still names the id it tried. The server waits for such a snapshot for 30 pulls, then gives up
and says so in the mark and the timeline.

After each outbox write the app posts the Darwin notification `fieldbook.<bundle id>.outbox`.

**Pruning.** When the app reads `ack` with `upTo: N`, it deletes every outbox item with `seq` ≤ N, and the snapshot folders and MetricKit files those items name. If the Mac never acknowledges, the app keeps at most 50 outbox items and drops the oldest first (and logs a `problem` event).

## Sessions (written by the server, on the Mac)

Sessions live in `$FIELDBOOK_HOME/sessions/<session id>/`. The default `FIELDBOOK_HOME` is `~/Library/Application Support/Fieldbook`.

Session ids look like `20261104-101500-before-fix-a1b2`: date, time, a short form of the label, and 4 random hex characters.

```
<session id>/
  session.json
  timeline.jsonl
  marks/<n>-<slug>/
    mark.json
    tree.json
    ax.json
    state.json
    screen-captured.png
    screen-rendered.png
    note.txt
  console.log
  crashes/
  metrickit/
  evidence.json
  raw/                  (the server's working copies: the mailbox, sent commands, captures)
```

### Evidence labels

Every value the server reports carries one label:

| label | meaning |
|---|---|
| `measured` | Measured on the device or the Mac. |
| `captured` | A real screenshot of the screen, taken by the system. |
| `rendered` | Drawn by the app itself. |
| `reported` | The app's own words or state, or the tester's note. Not checked. |
| `missing` | Could not be had. A `reason` says why. |

A labelled value is `{"label": "measured", "value": 412, "source": "events.jsonl launch"}` or `{"label": "missing", "reason": "the app did not answer"}`.

### session.json

```json
{
  "formatVersion": 1,
  "id": "20261104-101500-before-fix-a1b2",
  "label": "before fix",
  "target": "phone",
  "bundleId": "com.example.fieldbook.demo",
  "build": "a1b2c3d",
  "change": "IL-0210",
  "status": "recording",
  "startedAt": "…",
  "endedAt": null,
  "relaunched": false,
  "device": { "id": {…}, "name": {…}, "model": {…}, "osVersion": {…} },
  "app": { "version": {…}, "build": {…}, "commit": {…}, "containerAccess": {…} },
  "hello": { … the last hello.json … },
  "pullSeconds": 5,
  "pulls": { "count": 12, "lastAt": "…", "lastProblem": null },
  "commands": { "nextSeq": 3, "ackedUpTo": 4 },
  "crashLogsAtStart": ["FieldbookDemo-2026-11-01-090000.ips"],
  "problems": []
}
```

`build` and `change` are free text from the caller, for example a commit and a Code Director lock id. Fieldbook stores them and does not interpret them.

### timeline.jsonl

One line per thing that happened, oldest first:

```json
{"at":"2026-11-04T10:15:12.400Z","ms":12400,"kind":"mark","label":"measured","runId":"5C1E…","seq":14,"mark":{"n":3,"name":"pin on the wrong page","dir":"marks/3-pin-on-the-wrong-page","captured":true,"nodes":412}}
```

- `ms` is the time since the session started. The session start comes from the Mac clock; the event time from the device clock. The two clocks can differ a little.
- `kind` is one of the event kinds above, plus `crash` (a crash log was picked up) and `console` (not used for every line; `console.log` holds the app's printed output).

### marks/&lt;n&gt;-&lt;slug&gt;/

`n` counts the marks of the session from 1. `slug` is a short form of the mark's name, or its source (`shake`, `key`, `command`).

- `mark.json`: the mark, its labels, where each file came from.
- `tree.json`, `ax.json`, `state.json`, `screen-rendered.png`: copied from the app's snapshot.
- `screen-captured.png`: the real screenshot the Mac took for this mark (only for marks sent from the Mac).
- `note.txt`: the tester's words.

### evidence.json

See `docs/CODE-DIRECTOR-LINK.md`. It is written by the `evidence` tool, next to `session.json` for one session, or in `$FIELDBOOK_HOME/comparisons/<id>/` for a comparison.

```json
{
  "formatVersion": 1,
  "tool": "fieldbook",
  "toolVersion": "0.1.0",
  "kind": "comparison",
  "generatedAt": "…",
  "sessions": [ { "role": "a", "id": "…", "target": "phone", "device": {…}, "app": {…}, "build": "…", "change": "…", "startedAt": "…", "endedAt": "…", "metrics": {…} } ],
  "rules": [ { "id": "crashes", "a": {…}, "b": {…}, "thresholds": {…}, "verdict": "pass", "why": "…" } ],
  "warnings": [ "…" ],
  "files": [ { "path": "sessions/<id>/session.json", "sha256": "…", "bytes": 1234 } ]
}
```

File paths in `files` are relative to `FIELDBOOK_HOME`.

### fieldbook.json (optional settings)

`$FIELDBOOK_HOME/fieldbook.json` can change the defaults:

```json
{
  "formatVersion": 1,
  "pullSeconds": 5,
  "rules": {
    "crashes": { "maxIncrease": 0 },
    "launchMedian": { "ratio": 1.2, "minIncreaseMs": 100 },
    "peakMemory": { "ratio": 1.25 },
    "hangs": { "minMs": 250, "maxIncrease": 1 },
    "frameTolerancePt": 2
  }
}
```

## Changes to this format

| version | date | change |
|---|---|---|
| 1 | 2026-11-04 | First version. |
