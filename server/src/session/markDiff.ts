/**
 * Compares the trees of two marks with the same name: which elements went missing, which
 * moved more than the tolerance, and whose text fingerprint changed.
 *
 * An element is known by its accessibility identifier when it has one ("tree#pinnedBadge"),
 * otherwise by its path ("tree:UIWindow[0]/UIScrollView[0]/UILabel[0]").
 */
import fs from "node:fs";
import path from "node:path";
import { parseTree, type AXNode, type RedactedText, type Rect, type ViewNode } from "../format.ts";

interface Facts {
  frame: Rect;
  /** Fingerprints of the element's text, label and value, joined. */
  texts: string;
}

export interface MarkDifferences {
  missing: string[];
  added: string[];
  moved: { key: string; from: Rect; to: Rect; delta: number }[];
  textChanged: { key: string; from: string; to: string }[];
}

function fingerprint(...texts: (RedactedText | null | undefined)[]): string {
  return texts.map((text) => text?.sha256_8 ?? "-").join("/");
}

function addElement(map: Map<string, Facts>, source: string, id: string | null | undefined, at: string, facts: Facts): void {
  let key = id ? `${source}#${id}` : `${source}:${at}`;
  if (map.has(key)) {
    let count = 2;
    while (map.has(`${key}(${count})`)) count++;
    key = `${key}(${count})`;
  }
  map.set(key, facts);
}

function readTree<T>(file: string): ReturnType<typeof parseTree<T>> | undefined {
  try {
    return parseTree<T>(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Every element of a mark folder's tree.json and ax.json, by key. */
export function markElements(markDir: string): Map<string, Facts> {
  const map = new Map<string, Facts>();
  const views = readTree<ViewNode>(path.join(markDir, "tree.json"));
  const walkViews = (node: ViewNode, at: string) => {
    addElement(map, "tree", node.ax?.id, at, { frame: node.frame, texts: fingerprint(node.text, node.ax?.label, node.ax?.value) });
    node.children.forEach((child, index) => walkViews(child, `${at}/${child.type}[${index}]`));
  };
  for (const window of views?.windows ?? []) walkViews(window.root, `${window.root.type}[${window.index}]`);
  const ax = readTree<AXNode>(path.join(markDir, "ax.json"));
  const walkAx = (node: AXNode, at: string) => {
    addElement(map, "ax", node.id, at, { frame: node.frame, texts: fingerprint(node.label, node.value) });
    node.children.forEach((child, index) => walkAx(child, `${at}/${child.type}[${index}]`));
  };
  for (const window of ax?.windows ?? []) walkAx(window.root, `${window.root.type}[${window.index}]`);
  return map;
}

function largestShift(a: Rect, b: Rect): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));
}

export function diffMarks(markDirA: string, markDirB: string, tolerancePt: number): MarkDifferences {
  const a = markElements(markDirA);
  const b = markElements(markDirB);
  const result: MarkDifferences = { missing: [], added: [], moved: [], textChanged: [] };
  for (const [key, before] of a) {
    const after = b.get(key);
    if (!after) {
      result.missing.push(key);
      continue;
    }
    const delta = largestShift(before.frame, after.frame);
    if (delta > tolerancePt) result.moved.push({ key, from: before.frame, to: after.frame, delta: Math.round(delta * 10) / 10 });
    if (before.texts !== after.texts) result.textChanged.push({ key, from: before.texts, to: after.texts });
  }
  for (const key of b.keys()) if (!a.has(key)) result.added.push(key);
  return result;
}
