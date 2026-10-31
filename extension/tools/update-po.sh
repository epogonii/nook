#!/bin/bash
# Extracts strings into po/nook.pot and merges it into each po/*.po; new or changed
# strings come out untranslated or fuzzy.
set -euo pipefail
cd "$(dirname "$0")/.."

xgettext --from-code=UTF-8 --language=JavaScript --package-name=nook \
    --keyword=_ --keyword=ngettext:1,2 --keyword=pgettext:1c,2 \
    --add-comments=Translators --output=po/nook.pot \
    extension.js prefs.js lib/*.js ui/*.js prefs/*.js

for po in po/*.po; do
    [ -e "$po" ] || continue
    msgmerge --quiet --update --backup=none "$po" po/nook.pot
    msgfmt --check --statistics --output-file=/dev/null "$po"
done
