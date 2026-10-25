/** What every tool returns, and small helpers for plain summaries. */

/** A tool's answer: a plain summary first, then the data as JSON. */
export interface ToolAnswer<T> {
  summary: string;
  data: T;
}

/** A problem the caller can fix (unknown session, wrong input). The message is shown as is. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Bytes as "100.0 MB" (1 MB = 1024 × 1024 bytes). */
export function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Milliseconds since the start as "mm:ss.d". */
export function formatOffset(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const tenths = Math.round(Math.abs(ms) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${sign}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
}

/** A duration in words: "1 min 12 s", "8 s". */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
