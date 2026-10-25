/**
 * The numbers of one session, each with its label: crashes, launch times, peak memory,
 * hangs, error logs and marks. The timeline header, session_stop, compare and evidence use them.
 */
import type { Rules } from "../config.ts";
import { measured, missing, type Labeled } from "../labels.ts";
import type { SessionFile, TimelineEntry } from "./store.ts";

export interface SessionMetrics {
  crashes: Labeled<number>;
  launchesMs: Labeled<number[]>;
  launchMedianMs: Labeled<number>;
  peakMemoryBytes: Labeled<number>;
  /** Hangs of at least rules.hangs.minMs. */
  hangs: Labeled<number>;
  /** Error and fault log messages with numbers replaced by "#", without repeats. */
  errorMessages: string[];
  marks: number;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** "Could not open note 42 after 3 tries" → "Could not open note # after # tries" */
export function normalizeMessage(message: string): string {
  return message.replace(/\d+(?:[.,:]\d+)*/g, "#").replace(/\s+/g, " ").trim();
}

function payload<T>(entry: TimelineEntry): T {
  return entry[entry.kind] as T;
}

export function sessionMetrics(session: SessionFile, entries: readonly TimelineEntry[], rules: Rules): SessionMetrics {
  const of = (kind: string) => entries.filter((entry) => entry.kind === kind);
  const launches = of("launch").map((entry) => payload<{ ms: number }>(entry).ms);
  const memory = of("memory").map((entry) => payload<{ peak: number }>(entry).peak);
  const hangs = of("hang").filter((entry) => payload<{ ms: number }>(entry).ms >= rules.hangs.minMs);
  const errors = of("log")
    .map((entry) => payload<{ level: string; message: string }>(entry))
    .filter((log) => log.level === "error" || log.level === "fault")
    .map((log) => normalizeMessage(log.message));
  const source = "timeline.jsonl (from the app's events.jsonl)";
  return {
    crashes: crashCount(session),
    launchesMs: launches.length > 0 ? measured(launches, source) : missing("no launch was recorded (start with relaunch: true to measure one)"),
    launchMedianMs: launches.length > 0 ? measured(median(launches), source) : missing("no launch was recorded"),
    peakMemoryBytes: memory.length > 0 ? measured(Math.max(...memory), source) : missing("no memory sample was recorded"),
    hangs: session.pulls.count > 0 ? measured(hangs.length, source) : missing("the mailbox was never copied"),
    errorMessages: [...new Set(errors)].sort(),
    marks: of("mark").length,
  };
}

function crashCount(session: SessionFile): Labeled<number> {
  if (session.status !== "stopped") return missing("crash logs are picked up when the session stops");
  if (session.crashes.label === "missing") return missing(session.crashes.reason ?? "crash logs could not be read");
  return measured(session.crashes.value?.length ?? 0, session.crashes.source ?? "crash logs");
}
