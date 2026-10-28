/** Timeline entries as short lines of text, for example `00:12.4 mark 3 "pin on the wrong page" (screen captured, tree 412 nodes)`. */
import fs from "node:fs";
import path from "node:path";
import { formatBytes, formatOffset } from "../tools/common.ts";
import type { MarkFile } from "./ingest.ts";
import type { TimelineEntry } from "./store.ts";

function payload<T>(entry: TimelineEntry): T {
  return entry[entry.kind] as T;
}

function readMark(sessionDir: string, dir: string): MarkFile | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, dir, "mark.json"), "utf8")) as MarkFile;
  } catch {
    return undefined;
  }
}

export function markTitle(mark: { n: number; name: string | null; source: string }): string {
  return mark.name ? `mark ${mark.n} "${mark.name}"` : `mark ${mark.n} (${mark.source})`;
}

function markDetails(markFile: MarkFile | undefined): string {
  if (!markFile) return "(mark file missing)";
  const capture = markFile.parts.screenCaptured.label === "captured" ? "screen captured" : "no real capture";
  if (!markFile.snapshot) return `(${capture}, snapshot not copied yet)`;
  const tree = markFile.snapshot.nodes === null ? "no tree" : `tree ${markFile.snapshot.nodes} nodes`;
  const ax = markFile.snapshot.axNodes === null ? "" : `, accessibility ${markFile.snapshot.axNodes} nodes`;
  return `(${capture}, ${tree}${ax}${markFile.snapshot.truncated ? ", cut at 5000 nodes" : ""})`;
}

function describeEntry(entry: TimelineEntry, sessionDir: string): string {
  switch (entry.kind) {
    case "launch":
      return `launch ${payload<{ ms: number }>(entry).ms} ms`;
    case "lifecycle":
      return `lifecycle ${payload<{ state: string }>(entry).state}`;
    case "log": {
      const log = payload<{ level: string; category: string; message: string; cut: boolean }>(entry);
      return `log ${log.level} [${log.category}] ${log.message}${log.cut ? " (cut)" : ""}`;
    }
    case "hang":
      return `hang ${payload<{ ms: number }>(entry).ms} ms`;
    case "memory": {
      const memory = payload<{ footprint: number; peak: number }>(entry);
      return `memory ${formatBytes(memory.footprint)} (peak ${formatBytes(memory.peak)})`;
    }
    case "mark": {
      const mark = payload<{ n: number; name: string | null; source: string; dir: string }>(entry);
      return `${markTitle(mark)} ${markDetails(readMark(sessionDir, mark.dir))}`;
    }
    case "note": {
      const note = payload<{ n: number | null; markId: string; text: string }>(entry);
      return `note on ${note.n === null ? note.markId : `mark ${note.n}`}: "${note.text}"`;
    }
    case "snapshot": {
      const snapshot = payload<{ id: string; nodes: number; axNodes: number; dir: string }>(entry);
      return `snapshot ${snapshot.id} (tree ${snapshot.nodes} nodes, accessibility ${snapshot.axNodes} nodes) → ${snapshot.dir}`;
    }
    case "command": {
      const command = payload<{ name: string; via: string }>(entry);
      return `command ${command.name} read (via ${command.via})`;
    }
    case "metrickit": {
      const metrickit = payload<{ type: string; file: string }>(entry);
      return `metrickit ${metrickit.type} → ${metrickit.file}`;
    }
    case "problem": {
      const problem = payload<{ where: string; message: string }>(entry);
      return `problem in ${problem.where}: ${problem.message}`;
    }
    case "crash": {
      const crash = payload<{ name?: string; file: string | null }>(entry);
      return crash.file ? `crash log ${crash.file}` : `crash log ${crash.name ?? "?"} (listed, but it could not be copied)`;
    }
    default:
      return entry.kind;
  }
}

export function formatEntry(entry: TimelineEntry, sessionDir: string): string {
  return `${formatOffset(entry.ms)} ${describeEntry(entry, sessionDir)}`;
}
