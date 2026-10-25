/**
 * The only place that starts other programs. It takes an argv array (never a shell
 * string), always has a timeout, and can stream output and be stopped from outside.
 *
 * Nothing calls realExec directly: every command goes through ToolRunner (runner.ts),
 * which checks it against the allowlist first.
 */
import { spawn } from "node:child_process";

export interface ExecRequest {
  /** Program and arguments. argv[0] is looked up on PATH; no shell is involved. */
  argv: readonly string[];
  /** The command is stopped after this many milliseconds. */
  timeoutMs: number;
  /** Receives stdout as it arrives (for long-running commands such as a console). */
  onStdout?: (text: string) => void;
  /** Stops the command when aborted. */
  signal?: AbortSignal;
}

export interface ExecResult {
  /** Exit code, or null when the program could not start or was stopped by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the program could not be started at all. */
  error?: string;
}

export type Exec = (request: ExecRequest) => Promise<ExecResult>;

/** Output kept in memory per stream. Streamed output is passed on, not kept beyond this. */
const MAX_KEPT = 4 * 1024 * 1024;

function keep(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > MAX_KEPT ? next.slice(next.length - MAX_KEPT) : next;
}

export const realExec: Exec = (request) =>
  new Promise((resolve) => {
    const [program, ...args] = request.argv;
    if (program === undefined) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: false, error: "empty command" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(program, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, request.timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (request.signal?.aborted) onAbort();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = keep(stdout, chunk);
      request.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = keep(stderr, chunk);
    });
    child.on("error", (error) => {
      finish({ code: null, stdout, stderr, timedOut, aborted, error: error.message });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut, aborted });
    });
  });
