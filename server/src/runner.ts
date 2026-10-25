/**
 * ToolRunner: every external command passes here. It checks the allowlist, then runs the
 * command with a timeout. Tests replace the Exec with a fake; the allowlist check stays.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { checkArgv } from "./allowlist.ts";
import type { Exec, ExecResult } from "./exec.ts";

/** Thrown when a command is not on the allowlist. Nothing was run. */
export class RefusedCommand extends Error {
  readonly argv: readonly string[];
  constructor(argv: readonly string[], reason: string) {
    super(`Refused to run ${argv.slice(0, 4).join(" ")}: ${reason}`);
    this.name = "RefusedCommand";
    this.argv = argv;
  }
}

export interface RunOptions {
  timeoutMs?: number;
  onStdout?: (text: string) => void;
  signal?: AbortSignal;
}

export interface JsonRun {
  result: ExecResult;
  /** The parsed --json-output file, when the command wrote one. */
  json?: unknown;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export class ToolRunner {
  private readonly exec: Exec;
  private readonly scratchDir: string;

  constructor(exec: Exec, scratchDir: string) {
    this.exec = exec;
    this.scratchDir = scratchDir;
  }

  async run(argv: readonly string[], options: RunOptions = {}): Promise<ExecResult> {
    const check = checkArgv(argv);
    if (!check.ok) throw new RefusedCommand(argv, check.reason);
    return this.exec({
      argv,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onStdout: options.onStdout,
      signal: options.signal,
    });
  }

  /**
   * Runs a devicectl command built by `build(outputFile)`, which must pass --json-output
   * outputFile, and reads that file.
   */
  async runJson(build: (outputFile: string) => string[], options: RunOptions = {}): Promise<JsonRun> {
    fs.mkdirSync(this.scratchDir, { recursive: true });
    const outputFile = path.join(this.scratchDir, `devicectl-${randomBytes(6).toString("hex")}.json`);
    try {
      const result = await this.run(build(outputFile), options);
      let json: unknown;
      try {
        json = JSON.parse(fs.readFileSync(outputFile, "utf8"));
      } catch {
        json = undefined;
      }
      return { result, json };
    } finally {
      fs.rmSync(outputFile, { force: true });
    }
  }

  /** A fresh scratch file path (the caller writes and removes it). */
  scratchFile(name: string): string {
    fs.mkdirSync(this.scratchDir, { recursive: true });
    return path.join(this.scratchDir, `${randomBytes(4).toString("hex")}-${name}`);
  }
}

/** One short line about why a command failed, for summaries. */
export function failureText(result: ExecResult): string {
  if (result.error) return result.error;
  if (result.timedOut) return "it did not finish in time";
  const firstLine = (result.stderr || result.stdout).trim().split("\n").find((line) => line.trim().length > 0);
  return firstLine ? firstLine.trim().slice(0, 300) : `it ended with exit code ${result.code}`;
}
