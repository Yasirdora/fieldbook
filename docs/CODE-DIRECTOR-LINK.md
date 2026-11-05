# The link to Code Director

Code Director (`cdir`) is a separate tool for AI-assisted code changes: a lock from user
specifications, the change inside that fence, and a Change Report from measured evidence. Fieldbook
works without it. This page designs **one optional link**: a Code Director report can cite a Fieldbook recording as
evidence. Fieldbook's side is built (`evidence.json`). Code Director's side is a proposal that can be built under a lock. Nothing in the Code Director repository was changed.

Everything below about Code Director was read in https://github.com/Yasirdora/CodeDirector at commit
`f80110a221a21437b5c97a5f22c0d3bf4a125fa9` (4 Nov 2026, "report: a report shows the last attempt's
checks …"). File names are relative to `codedirector/`.

## 1. What Fieldbook gives

### build and change: stored, not interpreted

`session_start` takes two free-text fields:

- `build` — for example the commit the app was built from (`git rev-parse --short HEAD`, plus
  `-dirty` when the tree had uncommitted changes);
- `change` — for example the Code Director lock id, `IL-0210`.

Fieldbook stores both in `session.json` and in `evidence.json` and never interprets them. The app
also reports its own commit (Info.plist key `FieldbookCommit`, label *reported*).

### evidence.json

Written by the `evidence` tool, for one session (`sessions/<id>/evidence.json`) or for one comparison
(`comparisons/<id>/evidence.json`). The full format is in docs/FORMAT.md. In short:

```json
{
  "formatVersion": 1,
  "tool": "fieldbook",
  "toolVersion": "0.1.0",
  "kind": "comparison",
  "generatedAt": "2026-11-04T11:20:00.000Z",
  "line": "measured on the phone: crashes 0 → 0, launch 412 → 398 ms, hangs 1 → 1, peak memory 98.2 → 97.9 MB (rules: 0 fail, 0 warn, 5 pass, 0 unchecked)",
  "comparison": "20261104-112000-3f2a",
  "sessions": [
    {
      "role": "a", "id": "…", "label": "before", "target": "phone",
      "device": { "model": { "label": "measured", "value": "iPhone13,3", "source": "devicectl list devices" },
                  "osVersion": { "label": "measured", "value": "27.0.1", "source": "devicectl list devices" } },
      "app": { "bundleId": "com.example.sparrowpad", "version": {…}, "build": {…}, "commit": { "label": "reported", "value": "a1b2c3d" } },
      "build": "a1b2c3d", "change": "IL-0210", "status": "stopped",
      "startedAt": "…", "endedAt": "…",
      "metrics": { "crashes": {…}, "launchMedianMs": {…}, "peakMemoryBytes": {…}, "hangs": {…}, "errorMessages": {…}, "marks": 2 }
    },
    { "role": "b", "…": "…" }
  ],
  "rules": [
    { "id": "launchMedian", "title": "Launch time (median)", "thresholds": { "ratio": 1.2, "minIncreaseMs": 100 },
      "a": { "label": "measured", "value": 412 }, "b": { "label": "measured", "value": 398 },
      "verdict": "pass", "why": "passes: fails when b > a × 1.2 and b > a + 100 ms" }
  ],
  "marks": [ { "name": "pin on the wrong page", "verdict": "pass", "missing": 0, "moved": 0, "textChanged": 0, "added": 0 } ],
  "warnings": [],
  "files": [ { "path": "sessions/<id>/timeline.jsonl", "sha256": "…", "bytes": 12345 } ]
}
```

Properties that matter for Code Director:

- **Versioned:** `formatVersion` and `toolVersion`.
- **Self-contained:** the numbers, labels, thresholds and verdicts are inside the file. A reader
  does not need to open the session to report it.
- **Verifiable:** every cited file has its sha256 and size; paths are relative to `$FIELDBOOK_HOME`.
- **Honest labels:** each number carries `measured`, `reported` or `missing` (with a reason). A rule
  is `pass`, `warn`, `fail` or `unchecked`; there is never one overall score.
- **No private data:** device model and OS only, no device name or id, no absolute path.

## 2. What a Code Director report would need to read it

Each point names the Code Director file it builds on.

### 2.1 A new verification source, with the same item shape

`src/verify/types.ts` defines `VerificationItem` with `source: "keep-clause" | "typecheck" |
"verify-command"`, a `verdict` (`held` / `violated` / `unchecked`), an `evidenceClass`, a `detail`, an
optional `artifactRef` and a `reason`. **Proposal:** add the source `"device-recording"` and build one
item per Fieldbook rule:

| Fieldbook rule | Code Director item |
|---|---|
| `pass`, both numbers measured | `verdict: "held"`, `evidenceClass: "measured"` |
| `fail`, both numbers measured | `verdict: "violated"`, `evidenceClass: "measured"` |
| `warn` (new error messages, mark differences) | not a check: a **finding** (`Finding`, always `asserted`, in `src/report/report.ts`) listing what changed |
| `unchecked` (a number is missing) | `verdict: "unchecked"`, `reason` = Fieldbook's reason |

`subject`: `"device · launch time (median)"`. `detail`: `"a 412 ms, b 398 ms (fails when b > a × 1.2 and b > a + 100 ms)"`.
`artifactRef`: `"<path of evidence.json>#rules[launchMedian]"`.

Why "measured" fits a comparison: the README's evidence table defines **Measured** as "observed
differentially, pre and post, same harness" (`README.md`, "Evidence classes"). A Fieldbook comparison
is exactly that: the same steps on the same device, before and after the change.

### 2.2 Never upgrade a label

Code Director's `enforceArtifactRule` (`src/verify/types.ts`) downgrades a held claim without an
artifact reference to *asserted*, and the README states "anything not differentially observed is
Asserted at best". The mapping must follow the same law:

- A **single recording** (evidence kind `session`) has no "before". Its numbers are observations,
  not a differential check, so they are **asserted** findings ("measured on the phone: 0 crashes,
  launch 412 ms, 1 hang"), never held checks.
- Fieldbook `reported` values (the app's own state, its commit, the tester's note) are at most
  **asserted**.
- Fieldbook `missing` values are **unchecked**, with Fieldbook's reason.
- Screenshots (`captured`, `rendered`) are not claims. They go to the human: listed with the
  acceptance criteria ("Acceptance criteria (human judges)" in `src/report/format.ts`).

### 2.3 Check the file before trusting it

Code Director treats its own baseline as tamper-evident: it records the baseline's sha256 in the run
record and, on a mismatch, marks every dependent check unchecked (`RunRecord.baselineSha256` in
`src/run/run.ts`; README "Baselines are tamper-evident"). **Proposal:** the same for evidence.json:

1. `formatVersion` must be 1 and `tool` must be `"fieldbook"`; otherwise every device item is
   *unchecked*: "evidence.json has an unknown format".
2. Re-hash every file in `files`. Any mismatch or missing file → every device item *unchecked*:
   "a file the recording cites changed after it was written".
3. The recording must belong to this lock: at least session `b` must have `change` equal to the lock
   id (`VibeCheck.id`, `"IL-NNNN"` in `src/lock/types.ts`). Otherwise *unchecked*: "the recording is of
   another change".
4. The build should match the attempt: `RunRecord.checkpoint.ref` (`src/checkpoint/index.ts`) is the
   commit *before* the change; the "after" build is the commit that includes it. If session `b`'s
   `build` or reported `commit` equals `checkpoint.ref`, the "after" recording was made **before** the
   change → *unchecked*: "the after recording is of the old build".

### 2.4 Where Code Director finds the file

Two ways, the explicit one wins:

- **Explicit:** `cdir report IL-0210 --evidence <path to evidence.json>`, and the same input on the MCP
  `report` tool (the nine MCP tools are listed in the README, "Use it with an AI agent").
- **By lock id:** look in `$FIELDBOOK_HOME/comparisons/*/evidence.json` (then `sessions/*/evidence.json`)
  for the newest file whose session `b` (or only session) has `change == lockId`.

### 2.5 The plain summary line

`summarizeReport` in `src/report/format.ts` builds the one-glance summary: outcome first, then scope,
then checked promises, then what needs judgment. **Proposal:** after the checked promises, one sentence
built from evidence.json's `line`:

> Measured on the phone: 0 crashes, launch 412 → 398 ms, 1 hang.

Its hard rule stays: the word "verified" appears only when the report's verdict is verified. A failed
device rule makes the report *failed* only if the lock asked for it (see 2.7); otherwise it is shown,
violated, in the checks list.

### 2.6 An Unchecked item when UI changed and nothing was recorded

`src/report/format.ts` always renders the Unchecked bucket ("The Unchecked bucket is always visible —
naming it honestly is the feature"). **Proposal:** when the change touched UI and no evidence.json is
found for the lock, add one unchecked item:

> ? device — no Fieldbook recording for a change that touched UI (Sources/Notes/NoteListView.swift)

"Touched UI": a changed file (`RunRecord.changed`, `ClassifiedChange.path` in `src/run/classify.ts`)
that is Swift and imports SwiftUI, UIKit or AppKit. The Apple domain (`src/domains/apple/index.ts`)
already knows Swift projects; a small text check of the imports is enough. This item is circumstantial,
not declared, so it does not block "verified" (`declaredButUnrunnable` in `src/verify/types.ts` blocks
only checks the lock named).

### 2.7 Optional: let a lock ask for a device check

`KeepClauseKind` (`src/lock/types.ts`) lists the KEEP clauses (`output-unchanged`, `api-unchanged`,
`no-new-dependency`, `tests-pass`, `custom`). **Proposal for later:** a clause `device-rules-pass`.
With it, a missing recording is a declared check that could not run (blocks "verified", like
`declaredButUnrunnable`), and a failed rule is a violation. Without it, device evidence is
informational (2.5, 2.6).

### 2.8 Tests in Code Director's style

Code Director tests with `node:test`, writes the failing test first, and keeps an eval harness of YAML
cases run against the real CLI (`eval/README.md`; cases in `eval/cases/`). **Proposal:**

- `test/fieldbook-evidence.test.ts`: a fixture evidence.json (copy one written by Fieldbook's
  `evidence.test.ts`); tests for the mapping table in 2.1, each rule in 2.2 (a single session is never
  held), each check in 2.3 (a changed file → unchecked), and the summary line.
- `eval/cases/NN-device-evidence.yaml`: a case whose run writes an evidence.json with one failing rule,
  expecting `items: [{ match: "device · launch", class: measured, verdict: violated }]`.

## 3. How to use it

```
session_start {target: "phone", bundleId, label: "before", build: "<commit before>", change: "IL-0210"}
… the same steps …            session_stop
(the change is made under IL-0210; a new Debug build is installed from Xcode)
session_start {… label: "after", build: "<commit after>", change: "IL-0210"}
… the same steps …            session_stop
compare {a, b}  →  evidence {comparison}
cdir report IL-0210 --evidence ~/Library/Application Support/Fieldbook/comparisons/<id>/evidence.json
```
