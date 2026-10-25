/**
 * Context: what every tool needs — where Fieldbook keeps its files, the command runner,
 * the clock, and the sessions that are recording in this server process.
 */
import path from "node:path";
import { loadConfig, type Config } from "./config.ts";
import type { Exec } from "./exec.ts";
import { ToolRunner } from "./runner.ts";
import type { Recorder } from "./session/recorder.ts";

export interface Context {
  /** FIELDBOOK_HOME: sessions/, comparisons/, fieldbook.json. */
  home: string;
  runner: ToolRunner;
  /** The Mac user's home folder: app containers and crash reports are under it. */
  macHome: string;
  hostName: string;
  config: Config;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Pull on a timer while recording. Tests turn it off and pull by hand. */
  autoPull: boolean;
  /** Sessions recording in this process, by id. */
  recorders: Map<string, Recorder>;
}

export interface ContextOptions {
  exec: Exec;
  home: string;
  macHome: string;
  hostName: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  autoPull?: boolean;
}

export function createContext(options: ContextOptions): Context {
  return {
    home: options.home,
    runner: new ToolRunner(options.exec, path.join(options.home, "tmp")),
    macHome: options.macHome,
    hostName: options.hostName,
    config: loadConfig(options.home),
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    autoPull: options.autoPull ?? true,
    recorders: new Map(),
  };
}
