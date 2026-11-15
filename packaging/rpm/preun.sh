# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later
# shellcheck shell=sh

# RPM %preun: removed ($1 is 0; 1 on an upgrade), kationd stops before its program goes.
if [ "$1" -eq 0 ]; then
    kation_user_sessions remove
fi
exit 0
