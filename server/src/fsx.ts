/** Small file helpers: atomic writes, tolerant copies, hashes, slugs. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

/** Writes to a hidden temporary file in the same folder, then renames it over the target. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, file);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

/** The file's text, or undefined when it does not exist or cannot be read. */
export function readTextIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function appendLines(file: string, lines: readonly string[]): void {
  if (lines.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.map((line) => `${line}\n`).join(""));
}

/**
 * Copies a folder tree file by file. Skips names that start with "." (temporary files).
 * A file that disappears during the copy (the app pruned it) is skipped, not an error.
 */
export function copyTree(source: string, destination: string): number {
  let copied = 0;
  fs.mkdirSync(destination, { recursive: true });
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copied += copyTree(from, to);
    } else if (entry.isFile()) {
      try {
        fs.copyFileSync(from, to);
        copied++;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }
  return copied;
}

export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** "Pin on the wrong page!" → "pin-on-the-wrong-page" */
export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "x";
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** Every file under `dir`, relative to it, sorted. */
export function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}
