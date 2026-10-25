/** The Mac app's window number, read from its newest snapshot (needed for `screencapture -l`). */
import fs from "node:fs";
import path from "node:path";
import { parseSnapshotInfo, parseTree } from "../format.ts";

export function latestWindowNumber(mailboxDir: string): number | undefined {
  const snapshots = path.join(mailboxDir, "snapshots");
  if (!fs.existsSync(snapshots)) return undefined;
  const newest = fs
    .readdirSync(snapshots)
    .filter((name) => !name.startsWith("."))
    .map((name) => {
      try {
        const info = parseSnapshotInfo(fs.readFileSync(path.join(snapshots, name, "snapshot.json"), "utf8"));
        return { name, time: Date.parse(info.time) };
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is { name: string; time: number } => entry !== undefined)
    .sort((a, b) => b.time - a.time);
  for (const { name } of newest) {
    try {
      const tree = parseTree(fs.readFileSync(path.join(snapshots, name, "tree.json"), "utf8"));
      const window = tree.windows.find((candidate) => candidate.isKey && typeof candidate.number === "number") ??
        tree.windows.find((candidate) => typeof candidate.number === "number");
      if (window && typeof window.number === "number") return window.number;
    } catch {
      // This snapshot has no readable tree; try an older one.
    }
  }
  return undefined;
}
