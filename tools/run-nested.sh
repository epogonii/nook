#!/bin/bash
# Runs a nested GNOME Shell with this source installed, to try changes without logging
# out. dconf, extensions, cache and keyring live in a per-run dir under $XDG_RUNTIME_DIR
# (memory only), removed on exit.
#
# The real Mi Home login is copied into the nested keyring: the devices are real, and
# switching one there switches it for real. Nook settings carry over to the next window;
# camera logins entered there are copied to the real keyring (on close, or with --keep).
#
#   tools/run-nested.sh             window, until closed
#   tools/run-nested.sh --check     headless; reports whether the extension came up
#   tools/run-nested.sh --prefs     as --check, and opens the prefs window too
#   tools/run-nested.sh --shot DIR  headless; tools/probe saves screenshots to DIR
#   tools/run-nested.sh --keep      saves what the open window was set to
#
# NOOK_SCHEME=prefer-dark selects the dark style. The window needs mutter-devkit.
set -euo pipefail

SHOTS='card-camera snapshot card-climate card-climate-warm bar tabs-type tabs-accent tabs-room grid-type rooms-type control-type card-fan card-vacuum card-vacuum-2 card-vacuum-3 card-speaker card-tv prefs prefs-Devices prefs-Accounts prefs-Find notify locked'

# Everything runs inside main() so bash parses the whole file first: this script is
# often edited while a window it started is still open.
main() {
    local uuid=nook@epogonii.github.io probe=probe@nook.test
    src=$(cd "$(dirname "$0")/.." && pwd)
    local mode=${1:-} shots=${2:-}
    local runtime=${XDG_RUNTIME_DIR:?}
    state=$runtime/nook-preview

    if [ "$mode" = --keep ]; then
        local dir
        for dir in "$runtime"/nook-nested.*; do
            [ -e "$dir/window" ] && keep "$dir"
        done
        return
    fi

    if [ "$mode" = --shot ]; then
        [ -n "$shots" ] || { echo "usage: $0 --shot DIR" >&2; exit 2; }
        mkdir -p "$shots"
        shots=$(cd "$shots" && pwd)
        local name
        for name in $SHOTS; do
            rm -f "$shots/$name.png"
        done
        rm -f "$shots/done"
        rm -rf "${shots:?}/cards"
    fi

    sweep "$runtime"

    nested=$(mktemp -d "$runtime/nook-nested.XXXXXX")
    echo $$ > "$nested/owner"

    # gnome-shell creates this flag at startup and removes it a minute later. A nested
    # shell dying sooner leaves it in the real runtime dir, where it makes the real
    # shell's crash handling disable all extensions.
    flag=$runtime/gnome-shell-disable-extensions
    flag_was_there=$([ -e "$flag" ] && echo yes || echo no)
    trap cleanup EXIT
    trap "exit 1" INT TERM HUP

    mkdir -p "$nested/run" "$nested/cache"
    chmod 700 "$nested/run"
    local keep_state=''
    if [ -z "$mode" ]; then
        touch "$nested/window"
        mkdir -p -m 700 "$state"
        keep_state=$state
    fi
    [ -d "${XDG_CACHE_HOME:-$HOME/.cache}/nook" ] && cp -r "${XDG_CACHE_HOME:-$HOME/.cache}/nook" "$nested/cache/"

    local real_bus=$DBUS_SESSION_BUS_ADDRESS
    local user_id
    user_id=$(gsettings --schemadir "$src/schemas" get org.gnome.shell.extensions.nook xiaomi-user-id 2>/dev/null || echo "''")

    export XDG_CONFIG_HOME=$nested/config XDG_DATA_HOME=$nested/data XDG_CACHE_HOME=$nested/cache
    "$src/tools/install-local.sh" >/dev/null

    local enabled="'$uuid'"
    if [ "$mode" = --shot ]; then
        mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions/$probe"
        cp "$src"/tools/probe/* "$XDG_DATA_HOME/gnome-shell/extensions/$probe/"
        enabled="'$uuid', '$probe'"
        python3 -I "$src/tools/fake-gree.py" ecb 7000 600 &
        fake=$!
    fi

    # --devkit has its own monitor; an extra virtual one is unseen and may get the panel.
    local shell_args=(--devkit)
    [ -n "$mode" ] && shell_args=(--headless --virtual-monitor 1280x800)

    NOOK_USER_ID=$user_id NOOK_STATE=$keep_state dbus-run-session -- "$src/tools/nested-session.sh" \
        "$nested" "$real_bus" "$src" "$mode" "$shots" "$enabled" "${shell_args[@]}" 2>&1 |
        grep --line-buffered -E "^'|did not answer|nook|keyring-copy|prefs-shot|JS ERROR|JS WARNING|TypeError|ReferenceError|SyntaxError|Gjs-CRITICAL|Gjs-WARNING|Gtk-CRITICAL|St-CRITICAL|Clutter-CRITICAL" || true
}

keep() {
    local dir=$1
    if [ -s "$dir/config/dconf/user" ]; then
        mkdir -p -m 700 "$state"
        XDG_CONFIG_HOME=$dir/config dconf dump /org/gnome/shell/extensions/nook/ > "$state/nook.dconf.new" &&
            mv "$state/nook.dconf.new" "$state/nook.dconf"
    fi
    if [ -s "$dir/bus" ]; then
        DBUS_SESSION_BUS_ADDRESS=$(cat "$dir/bus") timeout 10 gjs -m "$src/tools/keyring-copy.js" get tapo tapo-admin |
            timeout 10 gjs -m "$src/tools/keyring-copy.js" put || true
    fi
}

remove_run() {
    local dir=$1 pid
    for pid in $(pgrep -u "$(id -u)" -f gnome-keyring-daemon || true); do
        if grep -qzx "XDG_RUNTIME_DIR=$dir/run" "/proc/$pid/environ" 2>/dev/null; then
            kill "$pid" || true
        fi
    done
    rm -rf "${dir:?}"
}

sweep() {
    local dir owner
    for dir in "$1"/nook-nested.*; do
        [ -d "$dir" ] || continue
        owner=$(cat "$dir/owner" 2>/dev/null || true)
        if [ -z "$owner" ] || ! kill -0 "$owner" 2>/dev/null; then
            remove_run "$dir"
        fi
    done
}

cleanup() {
    [ -n "${fake:-}" ] && kill "$fake" 2>/dev/null
    [ -e "$nested/window" ] && keep "$nested"
    remove_run "$nested"
    if [ "$flag_was_there" = no ]; then
        rm -f "$flag"
    fi
}

main "$@"
exit
