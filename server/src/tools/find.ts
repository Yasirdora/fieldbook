/**
 * find: elements in a mark's view tree (tree.json) and accessibility tree (ax.json).
 *
 * Queries: `id:<identifier>`, `label:<accessibility label>`, `value:<accessibility value>`,
 * `text:<view text>`, `type:<type name>`, `hash:<sha256_8>`, or plain text (identifier,
 * label or text). Text that was stored hashed is matched by its fingerprint, so it must
 * match exactly. Frames are in window points.
 */
import fs from "node:fs";
import path from "node:path";
import type { Context } from "../context.ts";
import { matchesText, parseTree, type AXNode, type RedactedText, type Rect, type ViewNode } from "../format.ts";
import type { MarkFile } from "../session/ingest.ts";
import { childrenOf, validFrame } from "../session/markDiff.ts";
import { SessionStore } from "../session/store.ts";
import { markTitle } from "../session/text.ts";
import { plural, ToolError, type ToolAnswer } from "./common.ts";

export type Field = "id" | "label" | "value" | "text" | "type" | "hash" | "any";

export interface Query {
  field: Field;
  value: string;
}

const FIELDS: readonly Field[] = ["id", "label", "value", "text", "type", "hash"];

export function parseQuery(query: string): Query {
  const colon = query.indexOf(":");
  const prefix = colon > 0 ? query.slice(0, colon) : "";
  if ((FIELDS as readonly string[]).includes(prefix)) return { field: prefix as Field, value: query.slice(colon + 1) };
  return { field: "any", value: query };
}

/** One element, flattened out of its tree. */
interface Element {
  source: "tree" | "ax";
  path: string;
  type: string;
  frame: Rect;
  window: number;
  id: string | null;
  axLabel: RedactedText | null;
  axValue: RedactedText | null;
  text: RedactedText | null;
  hidden?: boolean;
  alpha?: number;
  axSource?: string;
}

export interface FindMatch extends Element {
  /** Frames come from the app's own walk of its views. */
  label: "measured";
}

function flattenViews(node: ViewNode, at: string, out: Element[]): void {
  const frame = validFrame(node.frame);
  if (frame) out.push({
    source: "tree",
    path: at,
    type: node.type,
    frame,
    window: node.window,
    id: node.ax?.id ?? null,
    axLabel: node.ax?.label ?? null,
    axValue: node.ax?.value ?? null,
    text: node.text ?? null,
    hidden: node.hidden,
    alpha: node.alpha,
  });
  childrenOf<ViewNode>(node).forEach((child, index) => flattenViews(child, `${at}/${child.type}[${index}]`, out));
}

function flattenAccessibility(node: AXNode, at: string, window: number, out: Element[]): void {
  const frame = validFrame(node.frame);
  if (frame) out.push({
    source: "ax",
    path: at,
    type: node.type,
    frame,
    window,
    id: node.id ?? null,
    axLabel: node.label ?? null,
    axValue: node.value ?? null,
    text: null,
    axSource: node.source,
  });
  childrenOf<AXNode>(node).forEach((child, index) => flattenAccessibility(child, `${at}/${child.type}[${index}]`, window, out));
}

/** The elements of a mark's trees, and whether any tree could be read at all. */
function loadElements(markDir: string): { elements: Element[]; readable: boolean } {
  const elements: Element[] = [];
  const read = <T>(file: string) => {
    try {
      return parseTree<T>(fs.readFileSync(path.join(markDir, file), "utf8"));
    } catch {
      return undefined;
    }
  };
  const tree = read<ViewNode>("tree.json");
  for (const window of tree?.windows ?? []) {
    if (window?.root) flattenViews(window.root, `${window.root.type}[${window.index}]`, elements);
  }
  const ax = read<AXNode>("ax.json");
  for (const window of ax?.windows ?? []) {
    if (window?.root) flattenAccessibility(window.root, `${window.root.type}[${window.index}]`, window.index, elements);
  }
  return { elements, readable: tree !== undefined || ax !== undefined };
}

function typeMatches(type: string, wanted: string): boolean {
  return type === wanted || type.split(".").pop() === wanted;
}

function hashMatches(text: RedactedText | null, hash: string): boolean {
  return text !== null && text.sha256_8 === hash.toLowerCase();
}

function matches(element: Element, query: Query): boolean {
  switch (query.field) {
    case "id":
      return element.id === query.value;
    case "label":
      return matchesText(query.value, element.axLabel);
    case "value":
      return matchesText(query.value, element.axValue);
    case "text":
      return matchesText(query.value, element.text);
    case "type":
      return typeMatches(element.type, query.value);
    case "hash":
      return [element.axLabel, element.axValue, element.text].some((text) => hashMatches(text, query.value));
    case "any":
      return element.id === query.value || [element.axLabel, element.axValue, element.text].some((text) => matchesText(query.value, text));
  }
}

function search(elements: Element[], query: string): FindMatch[] {
  const parsed = parseQuery(query);
  return elements.filter((element) => matches(element, parsed)).map((element) => ({ ...element, label: "measured" as const }));
}

// -- geometry -----------------------------------------------------------------

const TOLERANCE_PT = 0.5;

function within(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x - TOLERANCE_PT &&
    inner.y >= outer.y - TOLERANCE_PT &&
    inner.x + inner.w <= outer.x + outer.w + TOLERANCE_PT &&
    inner.y + inner.h <= outer.y + outer.h + TOLERANCE_PT
  );
}

const round = (value: number) => Math.round(value * 10) / 10;

/** The shortest gap between two rectangles (0 when they touch or overlap), and the distance of their centers. */
export function distance(a: Rect, b: Rect): { gap: number; centers: number } {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  const cx = b.x + b.w / 2 - (a.x + a.w / 2);
  const cy = b.y + b.h / 2 - (a.y + a.h / 2);
  return { gap: round(Math.hypot(dx, dy)), centers: round(Math.hypot(cx, cy)) };
}

function samePlace(a: FindMatch, b: FindMatch): boolean {
  return a.source === b.source && a.window === b.window && a.path !== b.path;
}

export interface InsideAnswer {
  answer: "yes" | "partly" | "no" | "unknown";
  pairs: { a: string; b: string; source: string; structural: boolean; geometric: boolean }[];
}

function insideAnswer(as: FindMatch[], bs: FindMatch[]): InsideAnswer {
  const pairs = as.flatMap((a) =>
    bs.filter((b) => samePlace(a, b)).map((b) => ({
      a: a.path,
      b: b.path,
      source: a.source,
      structural: a.path.startsWith(`${b.path}/`),
      geometric: within(a.frame, b.frame),
    })),
  );
  if (pairs.length === 0) return { answer: "unknown", pairs };
  if (pairs.some((pair) => pair.structural && pair.geometric)) return { answer: "yes", pairs };
  if (pairs.some((pair) => pair.structural || pair.geometric)) return { answer: "partly", pairs };
  return { answer: "no", pairs };
}

export interface DistanceAnswer {
  pairs: { a: string; b: string; source: string; gap: number; centers: number }[];
}

function distanceAnswer(as: FindMatch[], bs: FindMatch[]): DistanceAnswer {
  return {
    pairs: as.flatMap((a) => bs.filter((b) => samePlace(a, b)).map((b) => ({ a: a.path, b: b.path, source: a.source, ...distance(a.frame, b.frame) }))),
  };
}

// -- the tool -----------------------------------------------------------------

export interface FindInput {
  session: string;
  mark: string;
  query: string;
  inside?: string;
  distanceTo?: string;
}

export interface FindData {
  mark: { n: number; dir: string };
  query: string;
  matches: FindMatch[];
  inside?: InsideAnswer & { query: string };
  distance?: DistanceAnswer & { query: string };
}

function findMarkDir(sessionDir: string, wanted: string, sessionId: string): { dir: string; mark: MarkFile } {
  const marksDir = path.join(sessionDir, "marks");
  const marks = (fs.existsSync(marksDir) ? fs.readdirSync(marksDir) : [])
    .map((dir) => {
      try {
        return { dir: `marks/${dir}`, mark: JSON.parse(fs.readFileSync(path.join(marksDir, dir, "mark.json"), "utf8")) as MarkFile };
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is { dir: string; mark: MarkFile } => entry !== undefined)
    .sort((a, b) => a.mark.n - b.mark.n);
  const lower = wanted.trim().toLowerCase();
  if (lower.length === 0) throw new ToolError("No mark given: give a mark number or name.");
  const found = marks.find((entry) => String(entry.mark.n) === lower || (entry.mark.name !== null && entry.mark.name.toLowerCase() === lower));
  if (found) return found;
  throw new ToolError(`No mark ${wanted} in session ${sessionId}. Marks: ${marks.map((entry) => markTitle(entry.mark)).join(", ") || "none"}.`);
}

function matchLine(match: FindMatch): string {
  const f = match.frame;
  const where = `at (${round(f.x)}, ${round(f.y)}) ${round(f.w)}×${round(f.h)}, window ${match.window}`;
  const extra = [match.id ? `id ${match.id}` : undefined, match.hidden ? "hidden" : undefined, match.alpha !== undefined && match.alpha < 1 ? `alpha ${match.alpha}` : undefined]
    .filter(Boolean)
    .join(", ");
  const source = match.source === "tree" ? "tree" : `accessibility (${match.axSource})`;
  return `  ${source} ${match.path} — ${match.type} ${where}${extra ? `, ${extra}` : ""}`;
}

export async function findTool(ctx: Context, input: FindInput): Promise<ToolAnswer<FindData>> {
  const store = new SessionStore(ctx.home);
  const session = store.read(input.session);
  const sessionDir = store.dir(session.id);
  const { dir, mark } = findMarkDir(sessionDir, input.mark, session.id);
  const { elements, readable } = loadElements(path.join(sessionDir, dir));
  const found = search(elements, input.query);
  const title = markTitle(mark);
  const lines: string[] = [];
  if (!readable) {
    const why = mark.parts?.tree?.reason ?? "the snapshot files are missing";
    lines.push(`${title.charAt(0).toUpperCase()}${title.slice(1)} has no view tree or accessibility tree to search: ${why}.`);
  } else if (found.length === 0) {
    lines.push(`No element matches ${input.query} in ${title}. Hashed text must match exactly (case and spaces).`);
  } else {
    const inTree = found.filter((match) => match.source === "tree").length;
    lines.push(`${plural(found.length, "match", "matches")} for ${input.query} in ${title}: tree ${inTree}, accessibility ${found.length - inTree}.`);
    lines.push(...found.map(matchLine));
  }
  const data: FindData = { mark: { n: mark.n, dir }, query: input.query, matches: found };
  if (input.inside) {
    const inside = insideAnswer(found, search(elements, input.inside));
    data.inside = { ...inside, query: input.inside };
    lines.push(`Inside ${input.inside}: ${inside.answer}${insideWhy(inside)}`);
  }
  if (input.distanceTo) {
    const result = distanceAnswer(found, search(elements, input.distanceTo));
    data.distance = { ...result, query: input.distanceTo };
    const first = result.pairs[0];
    lines.push(
      first
        ? `Distance to ${input.distanceTo}: gap ${first.gap} pt, centers ${first.centers} pt apart (${first.source}${result.pairs.length > 1 ? `; ${result.pairs.length} pairs in the data` : ""}).`
        : `Distance to ${input.distanceTo}: unknown — no pair of elements in the same tree and window.`,
    );
  }
  return { summary: lines.join("\n"), data };
}

function insideWhy(inside: InsideAnswer): string {
  const pair = inside.pairs.find((candidate) => candidate.structural || candidate.geometric) ?? inside.pairs[0];
  if (!pair) return " — the second element was not found in the same tree and window.";
  const structure = pair.structural ? "in its subtree" : "not in its subtree";
  const frame = pair.geometric ? "its frame lies within" : "its frame does not lie within";
  return ` — ${pair.source}: ${structure}, and ${frame}.`;
}
