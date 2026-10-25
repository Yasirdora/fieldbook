/**
 * Helpers shared by the device implementations: finding the mailbox in a copied folder,
 * putting a command file into a local inbox, and reading the Mac's crash reports.
 */
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fsx.ts";
import { measured, missing, type Labeled } from "../labels.ts";

const MARKERS = ["hello.json", "events.jsonl", "outbox"];

/**
 * The folder inside `stagingDir` that holds the mailbox. devicectl may copy a folder
 * into the destination or copy its contents; this finds the mailbox either way.
 */
export function findMailboxRoot(stagingDir: string, maxDepth = 4): string | undefined {
  const queue: { dir: string; depth: number }[] = [{ dir: stagingDir, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    if (MARKERS.some((marker) => names.includes(marker))) return dir;
    if (depth >= maxDepth) continue;
    for (const name of names.sort()) {
      const child = path.join(dir, name);
      if (!name.startsWith(".") && fs.statSync(child).isDirectory()) queue.push({ dir: child, depth: depth + 1 });
    }
  }
  return undefined;
}

export const NO_MAILBOX =
  "no hello.json or events.jsonl was found. Is the app a Debug build with FieldbookKit, and has it run since it was installed?";

/** Writes a command file into a local inbox folder (simulator or Mac), atomically. */
export function writeIntoInbox(mailboxDir: string, localFile: string, fileName: string): Labeled<true> {
  const inbox = path.join(mailboxDir, "inbox");
  if (!fs.existsSync(mailboxDir)) return missing(`the app's mailbox folder does not exist yet (${mailboxDir})`);
  try {
    writeFileAtomic(path.join(inbox, fileName), fs.readFileSync(localFile));
    return measured(true, "written into the inbox folder");
  } catch (error) {
    return missing(`could not write into the inbox: ${(error as Error).message}`);
  }
}

/** Crash reports on the Mac (Mac apps and simulator apps both report here). */
export function hostCrashReportsDir(macHome: string): string {
  return path.join(macHome, "Library", "Logs", "DiagnosticReports");
}

export function hostCrashLogNames(macHome: string): Labeled<string[]> {
  const dir = hostCrashReportsDir(macHome);
  try {
    const names = fs.readdirSync(dir).filter((name) => /\.(ips|crash)$/.test(name)).sort();
    return measured(names, `listed ${dir}`);
  } catch (error) {
    return missing(`could not list ${dir}: ${(error as Error).message}`);
  }
}

export function copyHostCrashLog(macHome: string, name: string, destinationDir: string): Labeled<string> {
  const source = path.join(hostCrashReportsDir(macHome), name);
  try {
    fs.mkdirSync(destinationDir, { recursive: true });
    const target = path.join(destinationDir, name);
    fs.copyFileSync(source, target);
    return measured(target, `copied from ${source}`);
  } catch (error) {
    return missing(`could not copy ${name}: ${(error as Error).message}`);
  }
}
