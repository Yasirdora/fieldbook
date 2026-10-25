/**
 * Where sessions live ($FIELDBOOK_HOME/sessions/<id>/) and what session.json and
 * timeline.jsonl hold. See "Sessions" in docs/FORMAT.md.
 */
import fs from "node:fs";
import path from "node:path";
import type { Target } from "../devices/types.ts";
import type { Hello } from "../format.ts";
import { appendLines, randomHex, readJson, slugify, writeJsonAtomic } from "../fsx.ts";
import type { Label, Labeled } from "../labels.ts";
import { ToolError } from "../tools/common.ts";

export interface SessionFile {
  formatVersion: 1;
  id: string;
  label: string;
  target: Target;
  bundleId: string;
  /** Free text from the caller (for example a commit). Not interpreted. */
  build: string | null;
  /** Free text from the caller (for example a Code Director lock id). Not interpreted. */
  change: string | null;
  status: "recording" | "stopped";
  startedAt: string;
  endedAt: string | null;
  relaunched: boolean;
  fullText: boolean;
  device: { id: string; name: string; model: Labeled<string>; osVersion: Labeled<string> };
  app: {
    installed: Labeled<boolean>;
    containerAccess: Labeled<boolean>;
    name: Labeled<string>;
    executable: Labeled<string>;
    version: Labeled<string>;
    build: Labeled<string>;
    commit: Labeled<string>;
  };
  /** The last hello.json the app wrote. */
  hello: Hello | null;
  pullSeconds: number;
  pulls: { count: number; lastAt: string | null; lastProblem: string | null };
  commands: { nextSeq: number; ackedUpTo: number };
  /** Every crash log name that existed when the session started (to find new ones at the end). */
  crashLogsAtStart: Labeled<string[]>;
  /** New crash logs of this app, copied at the end. */
  crashes: Labeled<string[]>;
  problems: string[];
}

/** One line of timeline.jsonl. The payload sits under a key named like `kind`. */
export type TimelineEntry = {
  at: string;
  /** Milliseconds since the session started. */
  ms: number;
  kind: string;
  label: Label;
  runId?: string;
  seq?: number;
} & Record<string, unknown>;

export class SessionStore {
  readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  get sessionsDir(): string {
    return path.join(this.home, "sessions");
  }

  dir(id: string): string {
    return path.join(this.sessionsDir, id);
  }

  /** `20261104-101500-before-fix-a1b2`: UTC date and time, a short form of the label, 4 random hex characters. */
  newId(label: string, now: Date): string {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    return `${stamp}-${slugify(label, 30)}-${randomHex(2)}`;
  }

  exists(id: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(id) && fs.existsSync(path.join(this.dir(id), "session.json"));
  }

  read(id: string): SessionFile {
    if (!this.exists(id)) {
      const known = this.list().slice(-5).join(", ");
      throw new ToolError(`No session ${id}.${known ? ` Recent sessions: ${known}.` : " There are no sessions yet."}`);
    }
    return readJson<SessionFile>(path.join(this.dir(id), "session.json"));
  }

  write(session: SessionFile): void {
    writeJsonAtomic(path.join(this.dir(session.id), "session.json"), session);
  }

  /** Session ids, oldest first. */
  list(): string[] {
    if (!fs.existsSync(this.sessionsDir)) return [];
    return fs.readdirSync(this.sessionsDir).filter((name) => this.exists(name)).sort();
  }

  appendTimeline(id: string, entries: readonly TimelineEntry[]): void {
    appendLines(path.join(this.dir(id), "timeline.jsonl"), entries.map((entry) => JSON.stringify(entry)));
  }

  readTimeline(id: string): TimelineEntry[] {
    const file = path.join(this.dir(id), "timeline.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TimelineEntry)
      .sort((a, b) => a.ms - b.ms);
  }
}
