#!/bin/bash
# Inner half of tools/run-nested.sh, run under dbus-run-session: a private keyring with
# Nook's logins copied in, then the nested shell. Not meant to be run by hand.
#
#   nested-session.sh NESTED REAL_BUS SRC MODE SHOTS ENABLED SHELL_ARGS...
set -euo pipefail

# Inside main() so bash parses the whole file first, like tools/run-nested.sh.
main() {
    local nested=$1 real_bus=$2 src=$3 mode=$4 shots=$5 enabled=$6
    shift 6
    local uuid=nook@epogonii.github.io

    # Random password for an in-memory keyring that dies with the run; never stored.
    local password
    password=$(head -c 24 /dev/urandom | base64)
    printf %s "$password" | XDG_RUNTIME_DIR="$nested/run" \
        gnome-keyring-daemon --daemonize --login --components=secrets >/dev/null
    XDG_RUNTIME_DIR="$nested/run" gnome-keyring-daemon --start --components=secrets >/dev/null
    DBUS_SESSION_BUS_ADDRESS="$real_bus" gjs -m "$src/tools/keyring-copy.js" get |
        gjs -m "$src/tools/keyring-copy.js" put

    printf %s "$DBUS_SESSION_BUS_ADDRESS" > "$nested/bus"

    # The devices are the Nook app's: with NOOK_APP set to its sources, run it on this bus.
    if [ -n "${NOOK_APP:-}" ]; then
        mkdir -p "$nested/app-schemas"
        glib-compile-schemas --targetdir="$nested/app-schemas" "$NOOK_APP/data"
        GSETTINGS_SCHEMA_DIR="$nested/app-schemas" gjs -m "$NOOK_APP/src/main.js" --gapplication-service &
        export NOOK_APP_SCHEMAS=$nested/app-schemas
    fi

    if [ -n "${NOOK_STATE:-}" ] && [ -s "$NOOK_STATE/nook.dconf" ]; then
        dconf load /org/gnome/shell/extensions/nook/ < "$NOOK_STATE/nook.dconf" || true
    fi

    if [ -n "${NOOK_SCHEME:-}" ]; then
        gsettings set org.gnome.desktop.interface color-scheme "$NOOK_SCHEME"
    fi
    gsettings set org.gnome.shell enabled-extensions "[$enabled]"
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings --schemadir "$src/schemas" set org.gnome.shell.extensions.nook xiaomi-user-id "${NOOK_USER_ID:-''}"

    NOOK_SHOT_DIR="$shots" gnome-shell --wayland --no-x11 "$@" --wayland-display="nook-nested-$$" &
    local shell=$!

    case "$mode" in
    '')
        wait "$shell" || true
        return
        ;;
    --shot)
        for _ in $(seq 1 150); do
            [ -e "$shots/done" ] && break
            sleep 1
        done
        ;;
    *)
        sleep "${NESTED_WAIT:-10}"
        gdbus call --session --dest org.gnome.Shell.Extensions \
            --object-path /org/gnome/Shell/Extensions \
            --method org.gnome.Shell.Extensions.GetExtensionInfo "$uuid" |
            grep -o "'state': <[^>]*>\|'error': <[^>]*>" || echo "the nested shell did not answer"
        if [ "$mode" = --prefs ]; then
            gdbus call --session --dest org.gnome.Shell.Extensions \
                --object-path /org/gnome/Shell/Extensions \
                --method org.gnome.Shell.Extensions.OpenExtensionPrefs "$uuid" '' '{}' >/dev/null || true
            sleep 6
        fi
        ;;
    esac
    kill "$shell" 2>/dev/null || true
    wait "$shell" || true
}

main "$@"
exit
