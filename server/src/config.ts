/**
 * Settings. Defaults below; $FIELDBOOK_HOME/fieldbook.json can change them (docs/FORMAT.md).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Rules {
  crashes: { maxIncrease: number };
  launchMedian: { ratio: number; minIncreaseMs: number };
  peakMemory: { ratio: number };
  hangs: { minMs: number; maxIncrease: number };
  frameTolerancePt: number;
}

export interface Config {
  pullSeconds: number;
  rules: Rules;
  /** Problems found while reading fieldbook.json. The defaults are used for those keys. */
  problems: string[];
}

export const DEFAULT_RULES: Rules = {
  crashes: { maxIncrease: 0 },
  launchMedian: { ratio: 1.2, minIncreaseMs: 100 },
  peakMemory: { ratio: 1.25 },
  hangs: { minMs: 250, maxIncrease: 1 },
  frameTolerancePt: 2,
};

export const DEFAULT_PULL_SECONDS = 5;

/** $FIELDBOOK_HOME, or ~/Library/Application Support/Fieldbook. */
export function defaultHome(): string {
  return process.env.FIELDBOOK_HOME ?? path.join(os.homedir(), "Library", "Application Support", "Fieldbook");
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Merges one group of numbers over its defaults, keeping only known keys with valid numbers. */
function mergeNumbers<T extends Record<string, number>>(defaults: T, given: unknown, name: string, problems: string[]): T {
  if (given === undefined) return { ...defaults };
  if (typeof given !== "object" || given === null) {
    problems.push(`rules.${name} is not an object; the defaults are used`);
    return { ...defaults };
  }
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(given)) {
    if (!(key in defaults)) problems.push(`rules.${name}.${key} is not a known setting`);
    else if (!positive(value)) problems.push(`rules.${name}.${key} must be a number ≥ 0`);
    else (merged as Record<string, number>)[key] = value;
  }
  return merged;
}

export function loadConfig(home: string): Config {
  const problems: string[] = [];
  const file = path.join(home, "fieldbook.json");
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      problems.push("fieldbook.json is not valid JSON; the defaults are used");
    }
  }
  const rules = (raw.rules ?? {}) as Record<string, unknown>;
  const pullSeconds = positive(raw.pullSeconds) && raw.pullSeconds >= 1 ? raw.pullSeconds : DEFAULT_PULL_SECONDS;
  return {
    pullSeconds,
    rules: {
      crashes: mergeNumbers(DEFAULT_RULES.crashes, rules.crashes, "crashes", problems),
      launchMedian: mergeNumbers(DEFAULT_RULES.launchMedian, rules.launchMedian, "launchMedian", problems),
      peakMemory: mergeNumbers(DEFAULT_RULES.peakMemory, rules.peakMemory, "peakMemory", problems),
      hangs: mergeNumbers(DEFAULT_RULES.hangs, rules.hangs, "hangs", problems),
      frameTolerancePt: positive(rules.frameTolerancePt) ? rules.frameTolerancePt : DEFAULT_RULES.frameTolerancePt,
    },
    problems,
  };
}
