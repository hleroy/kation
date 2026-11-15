# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later
# shellcheck shell=sh

# Debian prerm: removed (not upgraded), kationd stops before its program goes.
case "$1" in
remove) kation_user_sessions remove ;;
esac
exit 0
