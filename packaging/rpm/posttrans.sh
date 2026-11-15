# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later
# shellcheck shell=sh

# RPM %posttrans: after an install or an upgrade, once the old package's files
# are gone, the running kationd is the new one.
kation_user_sessions upgrade
exit 0
