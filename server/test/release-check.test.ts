/**
 * scripts/check-release-clean.sh, tested with fake .app folders.
 * It fails when a Release build contains any part of Fieldbook.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { tempDir } from "./helpers.ts";

const SCRIPT = path.join(import.meta.dirname, "..", "..", "scripts", "check-release-clean.sh");

/** Bytes that look like a binary, with the given strings inside. */
function fakeBinary(...strings: string[]): Buffer {
  const noise = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([noise, ...strings.flatMap((text) => [Buffer.from(text, "utf8"), Buffer.from([0, 1, 2, 0])]), noise]);
}

function iosApp(binary: Buffer, extra: (app: string) => void = () => {}): string {
  const app = path.join(tempDir("release"), "Sparrowpad.app");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(
    path.join(app, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleExecutable</key>\n\t<string>Sparrowpad</string>\n</dict>\n</plist>\n`,
  );
  fs.writeFileSync(path.join(app, "Sparrowpad"), binary);
  extra(app);
  return app;
}

function macApp(binary: Buffer): string {
  const app = path.join(tempDir("release-mac"), "Sparrowpad.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Sparrowpad</string></dict></plist>`,
  );
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "Sparrowpad"), binary);
  return app;
}

/** A fake `nm` on PATH that prints the given symbols. */
function fakeNm(symbols: string[]): string {
  const bin = tempDir("fake-nm");
  fs.writeFileSync(path.join(bin, "nm"), `#!/bin/sh\ncat <<'END'\n${symbols.join("\n")}\nEND\n`, { mode: 0o755 });
  return bin;
}

function check(app: string, env: Record<string, string> = {}) {
  const result = spawnSync("bash", [SCRIPT, app], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

test("the script is valid bash", () => {
  assert.equal(spawnSync("bash", ["-n", SCRIPT]).status, 0);
});

test("a clean Release build passes", () => {
  const { code, output } = check(iosApp(fakeBinary("Sparrowpad", "Garden plan", "com.example.sparrowpad")));
  assert.equal(code, 0, output);
  assert.match(output, /Clean: no part of Fieldbook found/);
});

test("the word Fieldbook in the binary's strings fails", () => {
  const { code, output } = check(iosApp(fakeBinary("Sparrowpad", "FieldbookKit.Probe")));
  assert.equal(code, 1);
  assert.match(output, /✗ "Fieldbook" found in: Sparrowpad/);
});

test("the fieldbook. notification prefix fails on its own", () => {
  const { code, output } = check(iosApp(fakeBinary("fieldbook.com.example.sparrowpad.inbox")));
  assert.equal(code, 1);
  assert.match(output, /✓ no "Fieldbook" in the binary's strings/);
  assert.match(output, /✗ the "fieldbook\." notification prefix found in: Sparrowpad/);
});

test("a FieldbookKit framework or bundle fails, and its strings are scanned too", () => {
  const app = iosApp(fakeBinary("Sparrowpad"), (folder) => {
    const framework = path.join(folder, "Frameworks", "FieldbookKit.framework");
    fs.mkdirSync(framework, { recursive: true });
    fs.writeFileSync(path.join(framework, "FieldbookKit"), fakeBinary("Fieldbook"));
  });
  const { code, output } = check(app);
  assert.equal(code, 1);
  assert.match(output, /✗ Fieldbook framework or bundle: Frameworks\/FieldbookKit\.framework/);
  assert.match(output, /Frameworks\/FieldbookKit\.framework\/FieldbookKit/);
});

test("on macOS, FieldbookKit symbols in nm output fail", () => {
  const app = macApp(fakeBinary("Sparrowpad"));
  const dirty = check(app, { FIELDBOOK_PLATFORM: "Darwin", PATH: `${fakeNm(["0000000100003f50 T _$s12FieldbookKit0A0O5startyyFZ"])}:${process.env.PATH}` });
  assert.equal(dirty.code, 1);
  assert.match(dirty.output, /✗ Fieldbook symbols in nm output/);
  const clean = check(app, { FIELDBOOK_PLATFORM: "Darwin", PATH: `${fakeNm(["0000000100003f50 T _main"])}:${process.env.PATH}` });
  assert.equal(clean.code, 0, clean.output);
  assert.match(clean.output, /✓ no Fieldbook symbols in nm output/);
});

test("on Linux the nm check is skipped and says so", () => {
  const { output } = check(macApp(fakeBinary("Sparrowpad")), { FIELDBOOK_PLATFORM: "Linux" });
  assert.match(output, /- nm check skipped: it runs only on macOS/);
});

test("wrong input exits with 2", () => {
  assert.equal(check(path.join(tempDir("none"), "Missing.app")).code, 2);
  const notApp = tempDir("not-an-app");
  assert.equal(check(notApp).code, 2);
  const noBinary = iosApp(Buffer.from(""));
  fs.rmSync(path.join(noBinary, "Sparrowpad"));
  assert.equal(check(noBinary).code, 2);
  assert.equal(spawnSync("bash", [SCRIPT]).status, 2);
});

test("Xcode's separate debug dylib next to the binary is scanned too", () => {
  const app = iosApp(fakeBinary("Sparrowpad"), (folder) => {
    fs.writeFileSync(path.join(folder, "Sparrowpad.debug.dylib"), fakeBinary("FieldbookKit.Probe"));
  });
  const { code, output } = check(app);
  assert.equal(code, 1);
  assert.match(output, /"Fieldbook" found in: Sparrowpad\.debug\.dylib/);
});
