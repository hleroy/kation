# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later
# shellcheck shell=sh

# Restarts or stops kationd in the running user sessions, from a package script
# run as root. cmake/KationPackaging.cmake puts it at the top of each package
# script (packaging/deb, packaging/rpm, packaging/arch).

# kation_user_sessions upgrade: reload the units and restart kationd where it
#   runs (try-restart starts nothing: sync that is off stays off).
# kation_user_sessions remove: stop kationd, its program is about to go.
# Never fails: a package operation must not depend on the users' sessions.
kation_user_sessions() {
    command -v systemctl >/dev/null 2>&1 || return 0
    # Fails when systemd does not run (a container, a chroot): no sessions to update.
    kation_managers=$(systemctl list-units --state=running --plain --no-legend 'user@*.service' 2>/dev/null) || return 0
    printf '%s\n' "$kation_managers" | while read -r kation_unit _; do
        kation_uid=${kation_unit#user@}
        kation_uid=${kation_uid%.service}
        case $kation_uid in '' | *[!0-9]*) continue ;; esac
        if [ "$1" = upgrade ]; then
            kation_user_systemctl "$kation_uid" daemon-reload
            # --no-block: the package manager does not wait for a transfer to stop.
            kation_user_systemctl "$kation_uid" try-restart --no-block kationd.service
        else
            kation_user_systemctl "$kation_uid" stop --no-block kationd.service
            kation_user_systemctl "$kation_uid" daemon-reload
        fi
    done
    return 0
}

# kation_user_systemctl UID ARGS...: systemctl in that user's manager (systemd 248+).
kation_user_systemctl() {
    kation_for=$1
    shift
    # A user manager that does not answer must not hold up the package manager.
    if command -v timeout >/dev/null 2>&1; then
        timeout 30 systemctl --user -M "$kation_for@" "$@" >/dev/null 2>&1 || true
    else
        systemctl --user -M "$kation_for@" "$@" >/dev/null 2>&1 || true
    fi
}
