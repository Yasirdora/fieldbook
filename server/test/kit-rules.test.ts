/**
 * The kit's rules, checked here on every run (the Swift test KitSourceRulesTests does the same on the Mac):
 * no unsafe concurrency escapes, no private API, no swizzling, and no networking in kit/Sources.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SOURCES = path.join(import.meta.dirname, "..", "..", "kit", "Sources");

/** Each banned thing, with the reason shown when it is found. */
const BANNED: { pattern: RegExp; why: string }[] = [
  { pattern: /@unchecked\s+Sendable/, why: "hides data races from the compiler" },
  { pattern: /nonisolated\s*\(\s*unsafe\s*\)/, why: "hides data races from the compiler" },
  { pattern: /@preconcurrency/, why: "turns off concurrency checks" },
  { pattern: /MainActor\s*\.\s*assumeIsolated/, why: "crashes when the assumption is wrong" },
  { pattern: /method_exchangeImplementations|method_setImplementation|class_replaceMethod/, why: "method swizzling" },
  { pattern: /swizzl/i, why: "method swizzling" },
  { pattern: /\bdlopen\b|\bdlsym\b/, why: "loads code by name (private API)" },
  { pattern: /NSClassFromString|NSSelectorFromString|perform\(\s*Selector\(\s*"/, why: "reaches classes or methods by name (private API)" },
  { pattern: /forKey(Path)?:\s*"_/, why: "reads a private property by key" },
  { pattern: /\bURLSession\b|\bURLRequest\b|NSURLConnection/, why: "networking" },
  { pattern: /import\s+Network\b|\bNWConnection\b|\bNWListener\b|\bNWPathMonitor\b/, why: "networking" },
  { pattern: /\bsocket\s*\(|\bCFSocket|\bCFStreamCreatePairWithSocket|\bStream\.getStreamsToHost/, why: "networking (sockets)" },
];

function swiftFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".swift"))
    .map((file) => path.join(dir, file));
}

/** Comments may name a banned thing (for example to say it is not used); code may not. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("kit/Sources has Swift files to check", () => {
  assert.ok(swiftFiles(SOURCES).length >= 5);
});

test("kit/Sources contains no banned construct, private API, swizzling or networking", () => {
  const problems: string[] = [];
  for (const file of swiftFiles(SOURCES)) {
    const code = withoutComments(fs.readFileSync(file, "utf8"));
    for (const { pattern, why } of BANNED) {
      if (pattern.test(code)) problems.push(`${path.relative(SOURCES, file)}: ${pattern} (${why})`);
    }
  }
  assert.deepEqual(problems, []);
});

test("Apple-only code sits behind canImport, so FieldbookCore stays platform-neutral", () => {
  for (const file of swiftFiles(path.join(SOURCES, "FieldbookCore"))) {
    const code = withoutComments(fs.readFileSync(file, "utf8"));
    assert.doesNotMatch(code, /import\s+(UIKit|AppKit|SwiftUI|MetricKit|OSLog|CoreMotion)\b/, path.basename(file));
  }
});

test("the scan itself works: it finds a banned construct in a sample", () => {
  const sample = "final class Box: @unchecked Sendable {}\nlet task = URLSession.shared";
  const found = BANNED.filter(({ pattern }) => pattern.test(withoutComments(sample)));
  assert.equal(found.length, 2);
});
