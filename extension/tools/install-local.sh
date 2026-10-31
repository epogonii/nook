#!/bin/bash
# Installs the extension into the user's extensions dir. Each file is written to a temp
# name and renamed into place: the running shell mmaps schemas/gschemas.compiled, and
# overwriting it in place can crash the session.
set -euo pipefail

uuid=nook@epogonii.github.io
src=$(cd "$(dirname "$0")/.." && pwd)
dst=${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid

install_file() {
    local from=$1 to=$2
    mkdir -p "$(dirname "$to")"
    cp "$from" "$to.tmp"
    mv -f "$to.tmp" "$to"
}


while read -r f; do
    install_file "$src/$f" "$dst/$f"
done < <(grep -v '^\s*\(#\|$\)' "$src/tools/files.txt")

glib-compile-schemas --targetdir "$src/schemas" "$src/schemas"
install_file "$src/schemas/gschemas.compiled" "$dst/schemas/gschemas.compiled"

shopt -s nullglob
for po in "$src"/po/*.po; do
    lang=$(basename "$po" .po)
    msgfmt "$po" -o "$src/po/$lang.mo"
    install_file "$src/po/$lang.mo" "$dst/locale/$lang/LC_MESSAGES/nook.mo"
    rm -f "$src/po/$lang.mo"
done

echo "installed to $dst"
echo "log out and back in - a running shell keeps the old code in memory"
