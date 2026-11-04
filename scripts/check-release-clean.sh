#!/bin/bash
# check-release-clean.sh <path to .app>
#
# Fails when a Release build still contains any part of Fieldbook:
#   1. the word "Fieldbook" in the binary's bytes (the app binary, a debug dylib next to it,
#      and its frameworks and plug-ins);
#   2. the "fieldbook." notification prefix;
#   3. a FieldbookKit or FieldbookCore framework or bundle;
#   4. on macOS only: Fieldbook symbols in nm output (nm reads Mach-O files only on a Mac).
#
# A file the script cannot read fails its check: a gate that cannot look must not pass.
#
# Exit 0: clean. Exit 1: Fieldbook found. Exit 2: wrong input.
# Written for the bash 3.2 that comes with macOS.
set -u

app="${1:-}"
if [ -z "$app" ]; then
  echo "Usage: $0 <path to .app>" >&2
  exit 2
fi
app="${app%/}"
if [ ! -d "$app" ] || [ "${app##*.}" != "app" ]; then
  echo "Not an .app folder: $app" >&2
  exit 2
fi

platform="${FIELDBOOK_PLATFORM:-$(uname -s)}"

# macOS apps keep everything under Contents/; iOS apps are flat.
if [ -d "$app/Contents" ]; then
  contents="$app/Contents"
  binary_dir="$contents/MacOS"
else
  contents="$app"
  binary_dir="$app"
fi

executable_name() {
  local plist="$contents/Info.plist"
  local name=""
  if [ -f "$plist" ] && command -v plutil >/dev/null 2>&1; then
    name="$(plutil -extract CFBundleExecutable raw -o - "$plist" 2>/dev/null || true)"
  fi
  if [ -z "$name" ] && [ -f "$plist" ]; then
    name="$(tr -d '\n\t' < "$plist" | sed -n 's:.*<key>CFBundleExecutable</key> *<string>\([^<]*\)</string>.*:\1:p')"
  fi
  if [ -z "$name" ]; then
    name="$(basename "$app" .app)"
  fi
  printf '%s' "$name"
}

binary="$binary_dir/$(executable_name)"
if [ ! -f "$binary" ]; then
  echo "No app binary at $binary" >&2
  exit 2
fi

echo "Checking Release build: $app"
echo "Binary: $binary"

failures=0
pass() { echo "✓ $1"; }
fail() {
  echo "✗ $1"
  failures=$((failures + 1))
}

# The files whose strings are scanned: the binary, any .dylib next to it (Xcode's separate
# debug dylib), and every file in Frameworks/ and PlugIns/.
scanned_files() {
  printf '%s\n' "$binary"
  find "$binary_dir" -maxdepth 1 -type f -name '*.dylib' 2>/dev/null
  find "$contents/Frameworks" "$contents/PlugIns" -type f 2>/dev/null
}

# Prints the files (relative to the .app) whose bytes contain the text, separated by ", ".
# grep reads the raw bytes: `strings` on a Mac parses Mach-O and refuses a file it cannot
# parse, and a refusal must not read as "not found". A file grep cannot read is named too.
files_with() { # text
  local found=""
  local file
  local status
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    LC_ALL=C grep -a -q -- "$1" "$file"
    status=$?
    if [ "$status" -eq 0 ]; then
      found="${found:+$found, }${file#"$app"/}"
    elif [ "$status" -ne 1 ]; then
      found="${found:+$found, }${file#"$app"/} (unreadable)"
    fi
  done <<EOF
$(scanned_files)
EOF
  printf '%s' "$found"
}

# 1. The word Fieldbook.
hits="$(files_with 'Fieldbook')"
if [ -z "$hits" ]; then pass "no \"Fieldbook\" in the binary's strings"; else fail "\"Fieldbook\" found in: $hits"; fi

# 2. The notification prefix.
hits="$(files_with 'fieldbook\.')"
if [ -z "$hits" ]; then pass "no \"fieldbook.\" notification prefix"; else fail "the \"fieldbook.\" notification prefix found in: $hits"; fi

# 3. A framework or bundle.
bundles="$(find "$app" \( -iname 'FieldbookKit*' -o -iname 'FieldbookCore*' \) -prune 2>/dev/null | sed "s:^$app/::" | tr '\n' ' ')"
if [ -z "$bundles" ]; then pass "no FieldbookKit or FieldbookCore framework or bundle"; else fail "Fieldbook framework or bundle: ${bundles% }"; fi

# 4. Symbols, on a Mac only.
if [ "$platform" = "Darwin" ]; then
  if ! command -v nm >/dev/null 2>&1; then
    fail "nm is not installed, so the symbols could not be checked"
  elif ! symbols="$(nm -a "$binary" 2>/dev/null)"; then
    fail "nm could not read $(basename "$binary"), so the symbols could not be checked"
  elif printf '%s\n' "$symbols" | grep -E -q 'FieldbookKit|FieldbookCore'; then
    fail "Fieldbook symbols in nm output of $(basename "$binary")"
  else
    pass "no Fieldbook symbols in nm output"
  fi
else
  echo "- nm check skipped: it runs only on macOS"
fi

if [ "$failures" -gt 0 ]; then
  echo "NOT clean: $failures check(s) found Fieldbook in this Release build."
  exit 1
fi
echo "Clean: no part of Fieldbook found."
exit 0
