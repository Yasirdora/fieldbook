/**
 * timeline: a concise text summary of session events. `around` (a mark number or name) narrows it to
 * ±`seconds` (default 10) around that mark. `kinds` chooses what to show; by default
 * everything except memory samples and command reads.
 */
import type { Context } from "../context.ts";
import { describe } from "../labels.ts";
import { sessionMetrics } from "../session/metrics.ts";
import { SessionStore, type SessionFile, type TimelineEntry } from "../session/store.ts";
import { formatEntry, markTitle } from "../session/text.ts";
import { formatBytes, plural, ToolError, type ToolAnswer } from "./common.ts";

export interface TimelineInput {
  session: string;
  around?: string;
  seconds?: number;
  kinds?: string[];
}

export interface TimelineData {
  session: { id: string; label: string; target: string; status: string; startedAt: string };
  around: { mark: number; ms: number; seconds: number } | null;
  entries: TimelineEntry[];
}

const HIDDEN_BY_DEFAULT = new Set(["memory", "command"]);
const DEFAULT_SECONDS = 10;

interface MarkPayload {
  n: number;
  name: string | null;
  source: string;
}

function findMark(entries: TimelineEntry[], around: string, sessionId: string): TimelineEntry {
  const marks = entries.filter((entry) => entry.kind === "mark");
  const wanted = around.trim().toLowerCase();
  const found = marks.find((entry) => {
    const mark = entry.mark as MarkPayload;
    return String(mark.n) === wanted || (mark.name ?? "").toLowerCase() === wanted;
  });
  if (found) return found;
  const known = marks.map((entry) => markTitle(entry.mark as MarkPayload)).join(", ") || "none";
  throw new ToolError(`No mark ${around} in session ${sessionId}. Marks: ${known}.`);
}

function header(session: SessionFile, entries: TimelineEntry[], ctx: Context): string[] {
  const metrics = sessionMetrics(session, entries, ctx.config.rules);
  const app = `app ${session.app.version.value ?? "?"} (${session.app.build.value ?? "?"})${session.app.commit.value ? `, commit ${session.app.commit.value}` : ""}`;
  const where = `${session.target} "${session.device.name}" (${[session.device.model.value, session.device.osVersion.value].filter(Boolean).join(", ")})`;
  const crashes = metrics.crashes.label === "missing" ? `crashes: ${metrics.crashes.reason}` : plural(metrics.crashes.value ?? 0, "crash", "crashes");
  return [
    `Session ${session.id} "${session.label}" — ${where}, ${app}. Status: ${session.status}.`,
    `Started ${session.startedAt.slice(11, 19)} UTC. ${plural(metrics.marks, "mark")}, ${plural(metrics.hangs.value ?? 0, "hang")} of ${ctx.config.rules.hangs.minMs} ms or more, ${crashes}, peak memory ${describe(metrics.peakMemoryBytes, formatBytes)}.`,
  ];
}

export async function timelineTool(ctx: Context, input: TimelineInput): Promise<ToolAnswer<TimelineData>> {
  const store = new SessionStore(ctx.home);
  const session = store.read(input.session);
  const all = store.readTimeline(session.id);
  let entries = input.kinds && input.kinds.length > 0
    ? all.filter((entry) => input.kinds?.includes(entry.kind))
    : all.filter((entry) => !HIDDEN_BY_DEFAULT.has(entry.kind));
  let around: TimelineData["around"] = null;
  if (input.around !== undefined) {
    const mark = findMark(all, input.around, session.id);
    const seconds = input.seconds ?? DEFAULT_SECONDS;
    around = { mark: (mark.mark as MarkPayload).n, ms: mark.ms, seconds };
    entries = entries.filter((entry) => Math.abs(entry.ms - mark.ms) <= seconds * 1000);
  }
  const dir = store.dir(session.id);
  const lines = [...header(session, all, ctx), ""];
  if (around) lines.push(`Around mark ${around.mark}, ±${around.seconds} s:`);
  lines.push(...entries.map((entry) => formatEntry(entry, dir)));
  if (entries.length === 0) lines.push("(nothing recorded yet)");
  return {
    summary: lines.join("\n"),
    data: {
      session: { id: session.id, label: session.label, target: session.target, status: session.status, startedAt: session.startedAt },
      around,
      entries,
    },
  };
}
