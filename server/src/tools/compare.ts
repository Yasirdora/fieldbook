/**
 * compare: two sessions of the same steps (before and after a change), with clear rules.
 * Each rule shows both numbers and pass, warn, fail or unchecked (a number is missing).
 * There is never one overall score. Thresholds come from fieldbook.json (docs/FORMAT.md).
 */
import fs from "node:fs";
import path from "node:path";
import type { Context } from "../context.ts";
import type { Rules } from "../config.ts";
import { randomHex, readJson, sha256File, writeJsonAtomic } from "../fsx.ts";
import { describe, has, measured, type Labeled } from "../labels.ts";
import type { MarkFile } from "../session/ingest.ts";
import { diffMarks, readableTrees, type MarkDifferences } from "../session/markDiff.ts";
import { sessionMetrics, type SessionMetrics } from "../session/metrics.ts";
import { SessionStore, type SessionFile } from "../session/store.ts";
import { formatBytes, plural, ToolError, type ToolAnswer } from "./common.ts";

export type Verdict = "pass" | "warn" | "fail" | "unchecked";

export interface RuleResult {
  id: "crashes" | "launchMedian" | "peakMemory" | "hangs" | "newErrors";
  title: string;
  thresholds: Record<string, number>;
  a: Labeled<number | string[]>;
  b: Labeled<number | string[]>;
  verdict: Verdict;
  why: string;
  /** newErrors only: new messages from Apple's frameworks (com.apple.*), listed, not judged. */
  system?: string[];
}

export interface MarkComparison extends MarkDifferences {
  name: string;
  a: { n: number; dir: string };
  b: { n: number; dir: string };
  verdict: "pass" | "warn" | "unchecked";
  /** Why the mark could not be compared (unchecked only). */
  why?: string;
}

export interface SessionRef {
  id: string;
  label: string;
  status: SessionFile["status"];
}

export interface CompareData {
  formatVersion: 1;
  id: string;
  createdAt: string;
  a: SessionRef;
  b: SessionRef;
  /** sha256 of each session's session.json and timeline.jsonl when it was compared (evidence checks them). */
  fingerprints: Record<string, string>;
  rules: RuleResult[];
  marks: MarkComparison[];
  unmatchedMarks: { a: string[]; b: string[] };
  warnings: string[];
}

function numberRule(
  id: RuleResult["id"],
  title: string,
  thresholds: Record<string, number>,
  a: Labeled<number>,
  b: Labeled<number>,
  fails: (a: number, b: number) => boolean,
  rule: string,
): RuleResult {
  if (!has(a) || !has(b) || !Number.isFinite(a.value) || !Number.isFinite(b.value)) {
    const which = !has(a) ? `a: ${a.reason}` : !has(b) ? `b: ${b.reason}` : "a value is not a finite number";
    return { id, title, thresholds, a, b, verdict: "unchecked", why: `cannot judge — ${which}` };
  }
  const failed = fails(a.value, b.value);
  return { id, title, thresholds, a, b, verdict: failed ? "fail" : "pass", why: `${failed ? "fails" : "passes"}: ${rule}` };
}

function rules(a: SessionMetrics, b: SessionMetrics, config: Rules): RuleResult[] {
  const { crashes, launchMedian, peakMemory, hangs } = config;
  const results = [
    numberRule("crashes", "Crashes", crashes, a.crashes, b.crashes, (x, y) => y > x + crashes.maxIncrease, `fails when b > a + ${crashes.maxIncrease}`),
    numberRule(
      "launchMedian",
      "Launch time (median)",
      launchMedian,
      a.launchMedianMs,
      b.launchMedianMs,
      (x, y) => y > x * launchMedian.ratio && y > x + launchMedian.minIncreaseMs,
      `fails when b > a × ${launchMedian.ratio} and b > a + ${launchMedian.minIncreaseMs} ms`,
    ),
    numberRule("peakMemory", "Peak memory", peakMemory, a.peakMemoryBytes, b.peakMemoryBytes, (x, y) => y > x * peakMemory.ratio, `fails when b > a × ${peakMemory.ratio}`),
    numberRule("hangs", `Hangs of ${hangs.minMs} ms or more`, hangs, a.hangs, b.hangs, (x, y) => y > x + hangs.maxIncrease, `fails when b > a + ${hangs.maxIncrease}`),
  ];
  return [...results, newErrorsRule(a, b)];
}

/**
 * New error or fault messages from the app (numbers stripped) are a warning, never a failure.
 * New messages from Apple's frameworks are listed, not judged: the system logs many on its own.
 */
function newErrorsRule(a: SessionMetrics, b: SessionMetrics): RuleResult {
  const title = "New error or fault log messages from the app (numbers stripped)";
  if (!has(a.errorMessages) || !has(b.errorMessages)) {
    const which = !has(a.errorMessages) ? `a: ${a.errorMessages.reason}` : `b: ${b.errorMessages.reason}`;
    return { id: "newErrors", title, thresholds: {}, a: a.errorMessages, b: b.errorMessages, verdict: "unchecked", why: `cannot judge — ${which}` };
  }
  const before = a.errorMessages.value;
  const fresh = b.errorMessages.value.filter((message) => !before.includes(message));
  const systemBefore = has(a.systemErrorMessages) ? a.systemErrorMessages.value : [];
  const system = has(b.systemErrorMessages) ? b.systemErrorMessages.value.filter((message) => !systemBefore.includes(message)) : [];
  const source = "the app's error and fault logs in timeline.jsonl (not com.apple.*), numbers replaced by #";
  return {
    id: "newErrors",
    title,
    thresholds: {},
    a: measured(before, source),
    b: measured(fresh, `${source}; only those a does not have`),
    verdict: fresh.length > 0 ? "warn" : "pass",
    why: fresh.length > 0 ? `b has ${plural(fresh.length, "message")} that a does not have` : "b has no message that a does not have",
    system,
  };
}

function readMarks(sessionDir: string): { dir: string; mark: MarkFile }[] {
  const marksDir = path.join(sessionDir, "marks");
  if (!fs.existsSync(marksDir)) return [];
  return fs
    .readdirSync(marksDir)
    .map((dir) => ({ dir: `marks/${dir}`, file: path.join(marksDir, dir, "mark.json") }))
    .filter((entry) => fs.existsSync(entry.file))
    .map((entry) => ({ dir: entry.dir, mark: readJson<MarkFile>(entry.file) }))
    .sort((x, y) => x.mark.n - y.mark.n);
}

/** Why a mark folder cannot be compared, or undefined when it has a readable tree. */
function unreadable(markDir: string): string | undefined {
  const trees = readableTrees(markDir);
  if (trees.tree || trees.ax) return undefined;
  try {
    const markFile = readJson<MarkFile>(path.join(markDir, "mark.json"));
    return `no readable tree.json or ax.json (${markFile.parts.tree.reason ?? "the snapshot is missing"})`;
  } catch {
    return "no readable tree.json or ax.json";
  }
}

function compareOneMark(dirA: string, dirB: string, left: { dir: string; mark: MarkFile }, right: { dir: string; mark: MarkFile }, tolerancePt: number): MarkComparison {
  const base = { name: left.mark.name as string, a: { n: left.mark.n, dir: left.dir }, b: { n: right.mark.n, dir: right.dir } };
  const empty = { missing: [], added: [], moved: [], textChanged: [] };
  const why = unreadable(path.join(dirA, left.dir)) ?? unreadable(path.join(dirB, right.dir));
  if (why) return { ...base, ...empty, verdict: "unchecked", why: `cannot compare — ${why}` };
  try {
    const differences = diffMarks(path.join(dirA, left.dir), path.join(dirB, right.dir), tolerancePt);
    const changed = differences.missing.length + differences.moved.length + differences.textChanged.length > 0;
    return { ...base, ...differences, verdict: changed ? "warn" : "pass" };
  } catch (error) {
    return { ...base, ...empty, verdict: "unchecked", why: `cannot compare — ${(error as Error).message}` };
  }
}

/** Marks with the same name are matched (the first of each name). Marks without a name are not matched. */
function compareMarks(dirA: string, dirB: string, tolerancePt: number): { marks: MarkComparison[]; unmatched: { a: string[]; b: string[] } } {
  const named = (dir: string) => readMarks(dir).filter((entry) => entry.mark.name);
  const marksA = named(dirA);
  const marksB = named(dirB);
  const marks: MarkComparison[] = [];
  for (const left of marksA) {
    const right = marksB.find((entry) => entry.mark.name === left.mark.name);
    if (!right || marks.some((done) => done.name === left.mark.name)) continue;
    marks.push(compareOneMark(dirA, dirB, left, right, tolerancePt));
  }
  const matched = new Set(marks.map((mark) => mark.name));
  return {
    marks,
    unmatched: {
      a: marksA.filter((entry) => !matched.has(entry.mark.name as string)).map((entry) => entry.mark.name as string),
      b: marksB.filter((entry) => !matched.has(entry.mark.name as string)).map((entry) => entry.mark.name as string),
    },
  };
}

/** sha256 of the files a comparison's verdicts come from. */
export function sessionFingerprints(home: string, ids: string[]): Record<string, string> {
  const prints: Record<string, string> = {};
  for (const id of ids) {
    for (const file of ["session.json", "timeline.jsonl"]) {
      const full = path.join(home, "sessions", id, file);
      prints[`sessions/${id}/${file}`] = fs.existsSync(full) ? sha256File(full) : "missing";
    }
  }
  return prints;
}

function warnings(a: SessionFile, b: SessionFile, newErrors: RuleResult): string[] {
  const list: string[] = [];
  for (const [role, session] of [["a", a], ["b", b]] as const) {
    if (session.status !== "stopped") list.push(`${role} is still recording: crash logs are picked up when it stops.`);
  }
  const place = (session: SessionFile) => `${session.target} ${session.device.model.value ?? "?"} ${session.device.osVersion.value ?? "?"}`;
  if (place(a) !== place(b)) list.push(`a ran on ${place(a)}, b on ${place(b)}: the numbers may not be comparable.`);
  for (const message of (newErrors.b.value as string[]) ?? []) list.push(`New error message in b: "${message}"`);
  return list;
}

const UNITS: Record<RuleResult["id"], (value: number | string[]) => string> = {
  crashes: String,
  launchMedian: (value) => `${value} ms`,
  peakMemory: (value) => formatBytes(value as number),
  hangs: String,
  newErrors: (value) => String((value as string[]).length),
};

function ruleLine(rule: RuleResult): string {
  const verdict = rule.verdict.padEnd(10);
  if (rule.id === "newErrors") {
    if (rule.verdict === "unchecked") return `${verdict} ${rule.title}: ${rule.why}.`;
    const quoted = (messages: string[]) => (messages.length > 0 ? ` — ${messages.map((message) => `"${message}"`).join(", ")}` : "");
    const fresh = (rule.b.value as string[]) ?? [];
    const system = rule.system ?? [];
    const systemLine = system.length > 0 ? ` New system messages (com.apple.*), listed, not judged: ${system.length}${quoted(system)}.` : "";
    return `${verdict} ${rule.title}: ${fresh.length}${quoted(fresh)}.${systemLine}`;
  }
  const show = (value: Labeled<number | string[]>) => describe(value, UNITS[rule.id]);
  if (rule.verdict === "unchecked") return `${verdict} ${rule.title}: a ${show(rule.a)}, b ${show(rule.b)}. ${rule.why}.`;
  const a = UNITS[rule.id](rule.a.value as number);
  const b = UNITS[rule.id](rule.b.value as number);
  return `${verdict} ${rule.title}: a ${a}, b ${b} (${rule.a.label === rule.b.label ? rule.a.label : `${rule.a.label} / ${rule.b.label}`}). It ${rule.why}.`;
}

function markLine(mark: MarkComparison, tolerancePt: number): string {
  if (mark.verdict === "unchecked") return `${mark.verdict.padEnd(10)} Mark "${mark.name}": ${mark.why}.`;
  const parts = [
    plural(mark.missing.length, "element") + " missing",
    `${mark.moved.length} moved more than ${tolerancePt} pt`,
    `${mark.textChanged.length} text changed`,
  ];
  return `${mark.verdict.padEnd(10)} Mark "${mark.name}": ${parts.join(", ")}${mark.added.length > 0 ? `, ${mark.added.length} new` : ""}.`;
}

export async function compareTool(ctx: Context, input: { a: string; b: string }): Promise<ToolAnswer<CompareData>> {
  const store = new SessionStore(ctx.home);
  const a = store.read(input.a);
  const b = store.read(input.b);
  const rulesConfig = ctx.config.rules;
  const metricsA = sessionMetrics(a, store.readTimeline(a.id), rulesConfig);
  const metricsB = sessionMetrics(b, store.readTimeline(b.id), rulesConfig);
  const results = rules(metricsA, metricsB, rulesConfig);
  const { marks, unmatched } = compareMarks(store.dir(a.id), store.dir(b.id), rulesConfig.frameTolerancePt);
  const id = `${ctx.now().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${randomHex(2)}`;
  const data: CompareData = {
    formatVersion: 1,
    id,
    createdAt: ctx.now().toISOString(),
    a: { id: a.id, label: a.label, status: a.status },
    b: { id: b.id, label: b.label, status: b.status },
    fingerprints: sessionFingerprints(ctx.home, [a.id, b.id]),
    rules: results,
    marks,
    unmatchedMarks: unmatched,
    warnings: warnings(a, b, results.find((rule) => rule.id === "newErrors") as RuleResult),
  };
  writeJsonAtomic(path.join(ctx.home, "comparisons", id, "comparison.json"), data);
  const lines = [
    `Compared a = ${a.id} "${a.label}" with b = ${b.id} "${b.label}". Each rule shows both numbers; there is no overall score.`,
    ...results.map(ruleLine),
    ...marks.map((mark) => markLine(mark, rulesConfig.frameTolerancePt)),
    ...(unmatched.a.length + unmatched.b.length > 0
      ? [`Marks without a partner: a ${unmatched.a.map((name) => `"${name}"`).join(", ") || "none"}; b ${unmatched.b.map((name) => `"${name}"`).join(", ") || "none"}.`]
      : []),
    ...data.warnings.filter((warning) => !warning.startsWith("New error message")).map((warning) => `Note: ${warning}`),
    `Saved comparisons/${id}/comparison.json. Run evidence with comparison: ${id} to write evidence.json.`,
  ];
  return { summary: lines.join("\n"), data };
}

/** Reads a saved comparison. */
export function readComparison(home: string, id: string): CompareData {
  const file = path.join(home, "comparisons", id, "comparison.json");
  if (!/^[A-Za-z0-9._-]+$/.test(id) || !fs.existsSync(file)) throw new ToolError(`No comparison ${id}. Run compare first.`);
  return readJson<CompareData>(file);
}

