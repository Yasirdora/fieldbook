/**
 * evidence: writes evidence.json, a small, versioned, self-contained record of one session
 * or of one comparison, for a Code Director report to cite (docs/CODE-DIRECTOR-LINK.md).
 *
 * It holds the numbers with their labels, the rules with their thresholds, and every file it
 * cites with its sha256. Paths are relative to FIELDBOOK_HOME; no absolute path, device name
 * or device id is written.
 */
import fs from "node:fs";
import path from "node:path";
import type { Context } from "../context.ts";
import { listFilesRecursive, sha256File, writeFileAtomic } from "../fsx.ts";
import { describe, measured, type Labeled } from "../labels.ts";
import { sessionMetrics, type SessionMetrics } from "../session/metrics.ts";
import { SessionStore, type SessionFile } from "../session/store.ts";
import { TOOL_VERSION } from "../version.ts";
import { formatBytes, ToolError, type ToolAnswer } from "./common.ts";
import { readComparison, type CompareData, type RuleResult } from "./compare.ts";

export interface EvidenceSession {
  role: "a" | "b" | "only";
  id: string;
  label: string;
  target: SessionFile["target"];
  device: { model: Labeled<string>; osVersion: Labeled<string> };
  app: { bundleId: string; version: Labeled<string>; build: Labeled<string>; commit: Labeled<string> };
  build: string | null;
  change: string | null;
  status: SessionFile["status"];
  startedAt: string;
  endedAt: string | null;
  metrics: Omit<SessionMetrics, "errorMessages"> & { errorMessages: Labeled<string[]> };
}

export interface EvidenceFile {
  formatVersion: 1;
  tool: "fieldbook";
  toolVersion: string;
  kind: "session" | "comparison";
  generatedAt: string;
  /** One plain line a Change Report can quote. */
  line: string;
  comparison: string | null;
  sessions: EvidenceSession[];
  rules: RuleResult[];
  marks: MarkSummary[];
  warnings: string[];
  files: { path: string; sha256: string; bytes: number }[];
}

interface MarkSummary {
  name: string;
  verdict: string;
  missing: number;
  moved: number;
  textChanged: number;
  added: number;
}

function evidenceSession(ctx: Context, store: SessionStore, id: string, role: EvidenceSession["role"]): EvidenceSession {
  const session = store.read(id);
  const metrics = sessionMetrics(session, store.readTimeline(id), ctx.config.rules);
  return {
    role,
    id: session.id,
    label: session.label,
    target: session.target,
    device: { model: session.device.model, osVersion: session.device.osVersion },
    app: { bundleId: session.bundleId, version: session.app.version, build: session.app.build, commit: session.app.commit },
    build: session.build,
    change: session.change,
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    metrics: { ...metrics, errorMessages: measured(metrics.errorMessages, "error and fault logs, numbers replaced by #") },
  };
}

/** Every file of a session bundle, except the server's working copies and earlier evidence. */
function sessionFiles(home: string, id: string): string[] {
  const dir = path.join(home, "sessions", id);
  return listFilesRecursive(dir)
    .filter((file) => !file.startsWith(`raw${path.sep}`) && file !== "evidence.json")
    .map((file) => path.join("sessions", id, file));
}

function cite(home: string, relativePaths: string[]): EvidenceFile["files"] {
  return relativePaths.map((relative) => {
    const full = path.join(home, relative);
    return { path: relative.split(path.sep).join("/"), sha256: sha256File(full), bytes: fs.statSync(full).size };
  });
}

const number = (labeled: Labeled<number>, format: (value: number) => string = String) =>
  labeled.label === "missing" || labeled.value === undefined ? "missing" : format(labeled.value);

function sessionLine(session: EvidenceSession): string {
  const m = session.metrics;
  const crashes = m.crashes.label === "missing" ? "crashes missing" : `${m.crashes.value} crash${m.crashes.value === 1 ? "" : "es"}`;
  const hangs = m.hangs.label === "missing" ? "hangs missing" : `${m.hangs.value} hang${m.hangs.value === 1 ? "" : "s"}`;
  return `measured on the ${session.target}: ${crashes}, launch ${number(m.launchMedianMs, (v) => `${v} ms`)}, ${hangs}, peak memory ${number(m.peakMemoryBytes, formatBytes)}`;
}

function comparisonLine(target: string, rules: RuleResult[]): string {
  const rule = (id: RuleResult["id"]) => rules.find((candidate) => candidate.id === id) as RuleResult;
  const pair = (id: RuleResult["id"], format: (value: number) => string = String) => {
    const { a, b } = rule(id);
    return `${number(a as Labeled<number>, format)} → ${number(b as Labeled<number>, format)}`;
  };
  const count = (verdict: string) => rules.filter((candidate) => candidate.verdict === verdict).length;
  const verdicts = ["fail", "warn", "pass", "unchecked"].map((verdict) => `${count(verdict)} ${verdict}`).join(", ");
  return `measured on the ${target}: crashes ${pair("crashes")}, launch ${pair("launchMedian")} ms, hangs ${pair("hangs")}, peak memory ${pair("peakMemory", (v) => (v / 1048576).toFixed(1))} MB (rules: ${verdicts})`;
}

/**
 * Replaces private words in every free text of the record: this Mac's folders, the device ids
 * and names of the cited sessions, and this Mac's name. Measured values (`value`) and the
 * cited files are left as they are.
 */
function scrub(value: unknown, replacements: [string, string][], key = ""): unknown {
  if (key === "value" || key === "files") return value;
  if (typeof value === "string") {
    return replacements.reduce((text, [secret, stand]) => (secret.length >= 3 ? text.split(secret).join(stand) : text), value);
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, replacements));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item, replacements, name)]));
  }
  return value;
}

/** Writes the file with no absolute path, device id, device name or Mac name in its texts. */
function writeEvidence(ctx: Context, store: SessionStore, file: string, evidence: EvidenceFile): void {
  const replacements: [string, string][] = [
    [ctx.home, "$FIELDBOOK_HOME"],
    [ctx.macHome, "~"],
    [ctx.hostName, "<this Mac>"],
  ];
  for (const session of evidence.sessions) {
    const device = store.read(session.id).device;
    replacements.push([device.id, "<device id>"], [device.name, "<device name>"]);
  }
  writeFileAtomic(file, `${JSON.stringify(scrub(evidence, replacements), null, 2)}\n`);
}

export async function evidenceTool(ctx: Context, input: { session?: string; comparison?: string }): Promise<ToolAnswer<{ path: string; evidence: EvidenceFile }>> {
  if (Boolean(input.session) === Boolean(input.comparison)) throw new ToolError("Give exactly one of session or comparison.");
  const store = new SessionStore(ctx.home);
  const base = { formatVersion: 1 as const, tool: "fieldbook" as const, toolVersion: TOOL_VERSION, generatedAt: ctx.now().toISOString() };
  let evidence: EvidenceFile;
  let file: string;
  if (input.session) {
    const session = evidenceSession(ctx, store, input.session, "only");
    file = path.join(ctx.home, "sessions", session.id, "evidence.json");
    evidence = { ...base, kind: "session", line: sessionLine(session), comparison: null, sessions: [session], rules: [], marks: [], warnings: [], files: cite(ctx.home, sessionFiles(ctx.home, session.id)) };
  } else {
    const comparison: CompareData = readComparison(ctx.home, input.comparison as string);
    const sessions = [evidenceSession(ctx, store, comparison.a.id, "a"), evidenceSession(ctx, store, comparison.b.id, "b")];
    file = path.join(ctx.home, "comparisons", comparison.id, "evidence.json");
    const files = [path.join("comparisons", comparison.id, "comparison.json"), ...sessionFiles(ctx.home, comparison.a.id), ...(comparison.a.id === comparison.b.id ? [] : sessionFiles(ctx.home, comparison.b.id))];
    evidence = {
      ...base,
      kind: "comparison",
      line: comparisonLine(sessions[1]?.target ?? "device", comparison.rules),
      comparison: comparison.id,
      sessions,
      rules: comparison.rules,
      marks: comparison.marks.map((mark) => ({ name: mark.name, verdict: mark.verdict, missing: mark.missing.length, moved: mark.moved.length, textChanged: mark.textChanged.length, added: mark.added.length })),
      warnings: comparison.warnings,
      files: cite(ctx.home, files),
    };
  }
  writeEvidence(ctx, store, file, evidence);
  const relative = path.relative(ctx.home, file);
  const verdicts = evidence.rules.length > 0 ? `${evidence.rules.length} rules (${["fail", "warn", "pass", "unchecked"].map((v) => `${evidence.rules.filter((r) => r.verdict === v).length} ${v}`).join(", ")}), ` : "";
  const summary = [
    `Wrote ${relative} (in FIELDBOOK_HOME): ${evidence.kind}, ${verdicts}${evidence.files.length} files cited with their sha256.`,
    `Line for a Change Report: "${evidence.line}".`,
    ...evidence.sessions.map((session) => `${session.role}: ${session.id} — app ${describe(session.app.version)} build ${describe(session.app.build)}, commit ${describe(session.app.commit)}, change ${session.change ?? "not given"}.`),
  ];
  return { summary: summary.join("\n"), data: { path: file, evidence } };
}
