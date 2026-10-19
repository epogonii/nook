#!/bin/bash
# Generates icons/qr/*.svg for the WALLETS addresses in prefs.js. Rerun after changing
# an address and commit the SVGs. Pre-rendered so the extension ships no QR encoder;
# the white background and 4-module quiet zone are baked in to scan on dark themes.
set -euo pipefail

cd "$(dirname "$0")/.."

mapfile -t wallets < <(sed -n '/^const WALLETS = \[/,/^\];/p' prefs.js \
    | sed -n "s/^\s*\['\([^']*\)', *'\([^']*\)'\].*$/\1\t\2/p")

if [[ ${#wallets[@]} -eq 0 ]]; then
    echo "no addresses found in prefs.js" >&2
    exit 1
fi

mkdir -p icons/qr

for wallet in "${wallets[@]}"; do
    name=${wallet%%$'\t'*}
    address=${wallet#*$'\t'}
    file="icons/qr/$(echo "$name" | tr '[:upper:] ' '[:lower:]-').svg"

    qrencode --type=SVG --level=M --size=8 --margin=4 \
        --foreground=000000 --background=FFFFFF \
        --output="$file" -- "$address"

    # Round qrencode's full-size background rect: no hard white square on dark pages.
    sed -i 's|\(<rect x="0" y="0" width="[0-9]*" height="[0-9]*"\) fill="#ffffff"|\1 rx="2" fill="#ffffff"|' "$file"

    if command -v magick >/dev/null && command -v zbarimg >/dev/null; then
        read_back=$(magick "$file" png:- | zbarimg --quiet --raw - | head -1)
        if [[ $read_back != "$address" ]]; then
            echo "$file does not read back as the $name address" >&2
            exit 1
        fi
        echo "$file  $name  scans"
    else
        echo "$file  $name  (install ImageMagick and zbar to have it checked)"
    fi
done
