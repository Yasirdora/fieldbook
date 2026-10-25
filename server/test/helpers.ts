/** Shared test helpers (not a test file). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Every temp folder of this test process goes under one folder, removed at exit. */
const TEST_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fieldbook-tests-"));
process.on("exit", () => fs.rmSync(TEST_TMP, { recursive: true, force: true }));

export const FIXTURES = path.join(import.meta.dirname, "fixtures");
export const FORMAT_FIXTURES = path.join(import.meta.dirname, "..", "..", "fixtures", "format-v1");

export function fixtureText(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

export function fixture(name: string): unknown {
  return JSON.parse(fixtureText(name));
}

/** A fresh empty folder. */
export function tempDir(prefix = "t"): string {
  return fs.mkdtempSync(path.join(TEST_TMP, `${prefix}-`));
}
