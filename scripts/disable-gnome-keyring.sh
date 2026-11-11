#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

# Stop GNOME Keyring from starting, so another Secret Service provider
# (KWallet by default) answers org.freedesktop.secrets. Nothing is uninstalled.
#
# Usage:
#   ./disable-gnome-keyring.sh            disable GNOME Keyring
#   ./disable-gnome-keyring.sh --undo     restore the default behaviour
#   ./disable-gnome-keyring.sh --force    disable even if KWallet is not installed
#                                         (e.g. you use KeePassXC as Secret Service)
#
# Exit status 3: a PAM file needs a change by hand (the script says which).
#
# Run as your normal user; sudo (or doas) is only used for PAM files.
# Safe to run more than once. Works with or without systemd.
#
# What it touches:
#   1. systemd user units gnome-keyring-daemon.{socket,service}   -> masked
#   2. XDG autostart entries gnome-keyring-*.desktop              -> hidden per user
#   3. D-Bus activation of org.freedesktop.secrets                -> KWallet (per user)
#   4. PAM lines "auth|session ... pam_gnome_keyring.so"          -> commented out
#
# Tested on Ubuntu/Debian layouts; written to also handle Fedora, Arch, openSUSE
# (vendor PAM files in /usr/lib/pam.d) and distros without systemd.

set -euo pipefail

MARK='#gnome-keyring-disabled# '        # prefix added to PAM lines we disable
VENDOR_MARK='# copied from vendor dir by disable-gnome-keyring.sh'

PAM_DIR=${PAM_DIR:-/etc/pam.d}
PAM_VENDOR_DIRS=${PAM_VENDOR_DIRS:-"/usr/lib/pam.d /usr/share/pam.d /usr/etc/pam.d"}
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
DBUS_FILE="$DATA_HOME/dbus-1/services/org.freedesktop.secrets.service"
AUTOSTART_DIR="$CONFIG_HOME/autostart"
UNITS=(gnome-keyring-daemon.socket gnome-keyring-daemon.service)

# auth/session lines loading pam_gnome_keyring ("-" prefix and full paths allowed).
# "password" lines are left alone: they only act when the daemon already runs.
PAM_LINE='-?(auth|session)[[:space:]]+[^[:space:]]+[[:space:]]+([^[:space:]]*/)?pam_gnome_keyring\.so'
PAM_ACTIVE="^[[:space:]]*$PAM_LINE"
PAM_OURS="^$MARK"
# Lines commented as "#-auth ..." by the first version of this script.
PAM_LEGACY='^#(-(auth|session)[[:space:]]+[^[:space:]]+[[:space:]]+([^[:space:]]*/)?pam_gnome_keyring\.so)'

# For tests only (scripts/test-disable-gnome-keyring.sh): run the PAM step alone.
PAM_ONLY=${GNOME_KEYRING_PAM_ONLY:-0}
# PAM files left unchanged because a jump passes over their keyring line.
SKIPPED=()

FORCE=0
MODE=disable
for arg in "$@"; do
    case "$arg" in
        --undo)  MODE=undo ;;
        --force) FORCE=1 ;;
        -h|--help) sed -n '5,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
    esac
done

if [[ $EUID -eq 0 && $PAM_ONLY != 1 ]]; then
    echo "Run this as your normal user, not root (it changes per-user settings)." >&2
    exit 1
fi

say()  { printf '%s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

# Run a command as root only when needed.
as_root() {
    if [[ -w "$PAM_DIR" ]]; then "$@"
    elif command -v sudo >/dev/null; then sudo "$@"
    elif command -v doas >/dev/null; then doas "$@"
    else echo "Need root for $PAM_DIR but neither sudo nor doas is available." >&2; exit 1
    fi
}

have_user_systemd() {
    command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1
}

# First KWallet binary that provides the Secret Service, newest first.
find_kwallet() {
    local name dir
    for name in ksecretd kwalletd6 kwalletd5; do
        command -v "$name" 2>/dev/null && return 0
        for dir in /usr/lib/*/libexec /usr/libexec /usr/lib/libexec /usr/lib64/libexec; do
            [[ -x "$dir/$name" ]] && { echo "$dir/$name"; return 0; }
        done
    done
    return 1
}

# PAM service files that are not backups or package-manager leftovers.
pam_files() {
    local dir f seen=" "
    for dir in "$PAM_DIR" $PAM_VENDOR_DIRS; do
        [[ -d "$dir" ]] || continue
        for f in "$dir"/*; do
            [[ -f "$f" ]] || continue
            case "$f" in *.bak|*~|*.dpkg-*|*.rpmnew|*.rpmsave|*.pacnew|*.pacsave|*.orig) continue ;; esac
            # A file in $PAM_DIR overrides the vendor file of the same name.
            [[ "$seen" == *" ${f##*/} "* ]] && continue
            seen+="${f##*/} "
            echo "$f"
        done
    done
}

# Prints "<keyring line> <jump line> <ours> <actions>" for each keyring line a
# jump skips: a "[...=N]" control skips the next N module lines of its type.
# Comments and @include lines are not modules; include/substack lines are.
# Lines this script commented out count as before (ours=1): their jump counted them.
pam_jumps() {
    KEYRING="^$PAM_LINE" MARK="$MARK" awk '
    function check(line, start,    ours, type, rest, control, item, kv, pos, j, i, n, reach) {
        ours = 0
        if (index(line, ENVIRON["MARK"]) == 1) {
            line = substr(line, length(ENVIRON["MARK"]) + 1)
            ours = 1
        } else if (line ~ /^#-/ && tolower(substr(line, 2)) ~ ENVIRON["KEYRING"]) {
            line = substr(line, 2)
            ours = 1
        }
        sub(/^[[:space:]]+/, "", line)
        if (line == "" || line ~ /^#/ || line ~ /^@/) return
        type = tolower(line)
        sub(/[[:space:]].*/, "", type)
        sub(/^-/, "", type)
        pos = ++count[type]
        at[type, pos] = start
        rest = line
        sub(/^[^[:space:]]+[[:space:]]+/, "", rest)
        if (rest ~ /^\[/) {
            control = rest
            sub(/\].*/, "", control)
            sub(/^\[/, "", control)
            # libpam allows spaces around "=".
            while (match(control, /[^[:space:]=]+[[:space:]]*=[[:space:]]*[0-9]+/)) {
                item = substr(control, RSTART, RLENGTH)
                gsub(/[[:space:]]/, "", item)
                split(item, kv, "=")
                if (kv[2] + 0 > 0) {
                    names[type, pos, ++actions[type, pos]] = kv[1]
                    values[type, pos, actions[type, pos]] = kv[2] + 0
                }
                control = substr(control, RSTART + RLENGTH)
            }
        }
        if ((type == "auth" || type == "session") && tolower(line) ~ ENVIRON["KEYRING"]) {
            for (j = 1; j < pos; j++) {
                reach = ""
                for (i = 1; i <= actions[type, j]; i++) {
                    if (values[type, j, i] >= pos - j) {
                        reach = reach (reach == "" ? "" : ",") names[type, j, i] "=" values[type, j, i]
                    }
                }
                if (reach != "") print start, at[type, j], ours, reach
            }
        }
    }
    {
        sub(/\r$/, "")
        if (buffer == "") {
            buffer = $0
            first = NR
        } else {
            buffer = buffer " " $0
        }
        # A line ending in "\" continues on the next one (not in a comment, which ends it).
        if (buffer !~ /^[[:space:]]*#/ && buffer ~ /\\$/) {
            sub(/\\$/, "", buffer)
            next
        }
        check(buffer, first)
        buffer = ""
    }
    END {
        if (buffer != "") check(buffer, first)
    }' "$1"
}

# Explains what pam_jumps found in a file, which is then left as it is.
report_jumps() {
    local f=$1 keyring_line jump_line ours reach
    while read -r keyring_line jump_line ours reach; do
        if [[ $ours == 1 ]]; then
            info "WARNING: $f, line $keyring_line (pam_gnome_keyring) was commented out by an earlier"
            info "  version of this script, but the jump on line $jump_line counted it, so that jump now"
            info "  lands one module further. Run this script with --undo, then again."
        else
            info "LEFT UNCHANGED: $f, line $keyring_line (pam_gnome_keyring) is skipped by the jump on line $jump_line."
            info "  To disable it by hand: comment out line $keyring_line, lower ${reach//,/ and } in line $jump_line"
            info "  by one (write \"ignore\" for a value that becomes 0), then run this script again."
        fi
    done <<<"$2"
    if [[ "${f%/*}" != "$PAM_DIR" ]]; then
        info "  $f is a vendor file: copy it to $PAM_DIR first, as updates replace it."
    fi
}

# ---------------------------------------------------------------- disable ---

disable_systemd() {
    say "1/4 systemd user units"
    if have_user_systemd; then
        systemctl --user mask "${UNITS[@]}" >/dev/null 2>&1
        systemctl --user stop "${UNITS[@]}" 2>/dev/null || true
        info "masked and stopped ${UNITS[*]}"
    else
        info "no systemd user session, skipped"
    fi
}

disable_autostart() {
    say "2/4 XDG autostart"
    local f name found=0
    for f in /etc/xdg/autostart/gnome-keyring-*.desktop; do
        [[ -f "$f" ]] || continue
        found=1
        name=${f##*/}
        mkdir -p "$AUTOSTART_DIR"
        # A per-user copy with Hidden=true disables the system entry.
        printf '[Desktop Entry]\nType=Application\nName=%s\nHidden=true\n' "$name" \
            > "$AUTOSTART_DIR/$name"
        info "hidden $name"
    done
    [[ $found -eq 1 ]] || info "no gnome-keyring autostart entries, skipped"
}

disable_dbus() {
    say "3/4 D-Bus activation of org.freedesktop.secrets"
    local kw
    if kw=$(find_kwallet); then
        mkdir -p "${DBUS_FILE%/*}"
        printf '[D-BUS Service]\nName=org.freedesktop.secrets\nExec=%s\n' "$kw" > "$DBUS_FILE"
        info "now activates $kw"
        if grep -Eqs '^apiEnabled=false' "$CONFIG_HOME/kwalletrc"; then
            info "WARNING: KWallet's Secret Service API is off. Enable it in"
            info "System Settings > KDE Wallet, or set apiEnabled=true under"
            info "[org.freedesktop.secrets] in $CONFIG_HOME/kwalletrc"
        fi
    else
        # Without an override, D-Bus would keep launching gnome-keyring on demand.
        # Pointing the name at /bin/false blocks that; your own provider
        # (e.g. KeePassXC) claims the name directly when it starts.
        mkdir -p "${DBUS_FILE%/*}"
        printf '[D-BUS Service]\nName=org.freedesktop.secrets\nExec=/bin/false\n' > "$DBUS_FILE"
        info "KWallet not found: blocked auto-launch of gnome-keyring"
    fi
}

disable_pam() {
    say "4/4 PAM ($PAM_DIR)"
    local f target changed=0
    local jumps
    while IFS= read -r f; do
        grep -Eq "$PAM_ACTIVE|$PAM_OURS|$PAM_LEGACY" "$f" || continue
        jumps=$(pam_jumps "$f")
        if [[ -n "$jumps" ]]; then
            # Commenting out such a line would make the jump land one module further.
            report_jumps "$f" "$jumps"
            SKIPPED+=("$f")
            continue
        fi
        grep -Eq "$PAM_ACTIVE" "$f" || continue
        target="$PAM_DIR/${f##*/}"
        if [[ "$f" != "$target" ]]; then
            # Vendor file (e.g. openSUSE /usr/lib/pam.d): override it in /etc.
            { echo "$VENDOR_MARK"; cat "$f"; } | as_root tee "$target" >/dev/null
            info "copied ${f} to $target"
        else
            [[ -e "$target.bak" ]] || as_root cp -p "$target" "$target.bak"
        fi
        as_root sed -i -E "s,^([[:space:]]*$PAM_LINE.*)$,$MARK\1," "$target"
        info "disabled pam_gnome_keyring in $target"
        changed=1
    done < <(pam_files)
    [[ $changed -eq 1 || ${#SKIPPED[@]} -gt 0 ]] || info "nothing active to disable"
    if grep -lqs 'pam-config' "$PAM_DIR"/common-auth 2>/dev/null; then
        info "NOTE: openSUSE pam-config may rewrite common-* files later;"
        info "if gnome-keyring comes back, run: sudo pam-config --delete --gnome_keyring"
    fi
}

# ------------------------------------------------------------------- undo ---

undo_all() {
    local f
    if [[ $PAM_ONLY != 1 ]]; then
        say "1/4 systemd user units"
        if have_user_systemd; then
            systemctl --user unmask "${UNITS[@]}" >/dev/null 2>&1
            info "unmasked ${UNITS[*]}"
        else
            info "no systemd user session, skipped"
        fi

        say "2/4 XDG autostart"
        for f in "$AUTOSTART_DIR"/gnome-keyring-*.desktop; do
            [[ -f "$f" ]] && grep -qx 'Hidden=true' "$f" && rm -f "$f" && info "restored ${f##*/}"
        done

        say "3/4 D-Bus activation of org.freedesktop.secrets"
        rm -f "$DBUS_FILE"
        info "removed per-user override"
    fi

    say "4/4 PAM ($PAM_DIR)"
    for f in "$PAM_DIR"/*; do
        [[ -f "$f" ]] || continue
        if head -n1 "$f" | grep -qxF "$VENDOR_MARK"; then
            as_root rm -f "$f"
            info "removed $f (vendor file is used again)"
        elif grep -Eq "$PAM_OURS|$PAM_LEGACY" "$f"; then
            as_root sed -i -E -e "s,$PAM_OURS,," -e "s,$PAM_LEGACY,\1," "$f"
            info "re-enabled pam_gnome_keyring in $f"
        fi
    done
}

# ------------------------------------------------------------------- main ---

if [[ $MODE == undo ]]; then
    undo_all
else
    if ! find_kwallet >/dev/null && [[ $FORCE -eq 0 ]]; then
        echo "KWallet is not installed, so nothing would replace GNOME Keyring" >&2
        echo "and apps could no longer save passwords. Install KWallet, or re-run" >&2
        echo "with --force if another Secret Service provider (e.g. KeePassXC) is set up." >&2
        exit 1
    fi
    case "${XDG_CURRENT_DESKTOP:-}" in
        *GNOME*|*Unity*|*Cinnamon*|*MATE*|*Budgie*)
            echo "Note: $XDG_CURRENT_DESKTOP relies on GNOME Keyring; this disables it there too." ;;
    esac
    if [[ $PAM_ONLY != 1 ]]; then
        disable_systemd
        disable_autostart
        disable_dbus
    fi
    disable_pam
fi

say ""
say "Done. Reboot for the change to take full effect, then check:"
say "    pgrep -a gnome-keyring          # should print nothing (after disabling)"
say "    busctl --user status org.freedesktop.secrets 2>/dev/null | grep -E '^(Comm|CommandLine)='"

if [[ ${#SKIPPED[@]} -gt 0 ]]; then
    say ""
    say "WARNING: these PAM files need a change by hand (see above): ${SKIPPED[*]}"
    exit 3
fi
