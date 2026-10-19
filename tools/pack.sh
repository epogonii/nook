#!/bin/bash
# Builds nook.zip for extensions.gnome.org from tools/files.txt only: no tools or test
# helpers, since reviewers read every uploaded line.
set -euo pipefail

# zip reads default options from $ZIP and $ZIPOPT; an unrelated ZIP in the environment
# (e.g. a CI step naming its asset) would change where the archive is written.
unset ZIP ZIPOPT

src=$(cd "$(dirname "$0")/.." && pwd)
out=$src/nook.zip
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cd "$src"

while read -r f; do
    mkdir -p "$work/$(dirname "$f")"
    cp "$f" "$work/$f"
done < <(grep -v '^\s*\(#\|$\)' tools/files.txt)

# extensions.gnome.org compiles schemas itself and rejects a shipped gschemas.compiled.
glib-compile-schemas --strict --dry-run schemas

shopt -s nullglob
for po in po/*.po; do
    lang=$(basename "$po" .po)
    mkdir -p "$work/locale/$lang/LC_MESSAGES"
    msgfmt "$po" -o "$work/locale/$lang/LC_MESSAGES/nook.mo"
done

rm -f "$out"
(cd "$work" && zip -q -r -X "$out" .)

printf '%s\n' "$out"
unzip -l "$out" | tail -n +4 | head -n -2 | awk '{print "  " $4}'
printf '%s\n' "$(du -h "$out" | cut -f1)"
