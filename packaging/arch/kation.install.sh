# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later
# shellcheck shell=bash disable=SC2317

# pacman install script: functions pacman calls around the transaction.
post_install() {
    kation_user_sessions upgrade
}

post_upgrade() {
    kation_user_sessions upgrade
}

pre_remove() {
    kation_user_sessions remove
}
