# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later
# shellcheck shell=sh

# Debian postinst: after an install or an upgrade, the running kationd is the new one.
case "$1" in
configure) kation_user_sessions upgrade ;;
esac
exit 0
