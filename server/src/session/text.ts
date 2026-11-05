/** Timeline entries as short lines of text, for example `00:12.4 mark 3 "pin on the wrong page" (screen captured, tree 412 nodes)`. */
import fs from "node:fs";
import path from "node:path";
import { parseTree, type AXNode, type Tree } from "../format.ts";
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

/**
 * The accessibility tree in words. A tree with nothing below its window roots is not a
 * measurement of the screen: SwiftUI builds its accessibility elements only while an
 * assistive technology (VoiceOver, Accessibility Inspector) is attached, so without one
 * the tree is bare windows. Measured: one bare window on a simulator; two on an iPhone
 * (the app's window and the keyboard's UITextEffectsWindow); 32 and 33 nodes with one
 * attached. When `axFile` (the tree's ax.json) can be read, its windows decide; otherwise
 * a count of 1 or less does.
 */
export function accessibilityText(nodes: number | null | undefined, label = "", axFile?: string): string {
  if (nodes === null || nodes === undefined) return `accessibility ? nodes${label}`;
  const tree = axFile === undefined ? undefined : readAXTree(axFile);
  const empty = tree ? tree.windows.every((window) => (window.root?.children?.length ?? 0) === 0) : nodes <= 1;
  if (empty) return "accessibility tree empty (missing: SwiftUI builds it only while VoiceOver or Accessibility Inspector is attached)";
  return `accessibility ${nodes} nodes${label}`;
}

function readAXTree(file: string): Tree<AXNode> | undefined {
  try {
    return parseTree<AXNode>(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function markTitle(mark: { n: number; name: string | null; source: string }): string {
  return mark.name ? `mark ${mark.n} "${mark.name}"` : `mark ${mark.n} (${mark.source})`;
}

function markDetails(markFile: MarkFile | undefined, markDir: string): string {
  if (!markFile) return "(mark file missing)";
  const capture = markFile.parts.screenCaptured.label === "captured" ? "screen captured" : "no real capture";
  if (!markFile.snapshot) return `(${capture}, snapshot not copied yet)`;
  const tree = markFile.snapshot.nodes === null ? "no tree" : `tree ${markFile.snapshot.nodes} nodes`;
  const ax = markFile.snapshot.axNodes === null ? "" : `, ${accessibilityText(markFile.snapshot.axNodes, "", path.join(markDir, "ax.json"))}`;
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
      return `${markTitle(mark)} ${markDetails(readMark(sessionDir, mark.dir), path.join(sessionDir, mark.dir))}`;
    }
    case "note": {
      const note = payload<{ n: number | null; markId: string; text: string }>(entry);
      return `note on ${note.n === null ? note.markId : `mark ${note.n}`}: "${note.text}"`;
    }
    case "snapshot": {
      const snapshot = payload<{ id: string; nodes: number; axNodes: number; dir: string }>(entry);
      const axFile = path.join(sessionDir, snapshot.dir, "ax.json");
      return `snapshot ${snapshot.id} (tree ${snapshot.nodes} nodes, ${accessibilityText(snapshot.axNodes, "", axFile)}) → ${snapshot.dir}`;
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
