#! /usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

# Extracts the translatable strings of the KDE components into the "kation"
# catalog. KDE's scripty convention: $XGETTEXT and $podir come from the caller,
# here po/update.sh.
# $XGETTEXT is a command line and the file list is split on purpose (the
# sources have no spaces in their names); $podir is set by the caller.
# shellcheck disable=SC2086,SC2046,SC2154
$XGETTEXT $(find kde -name '*.cpp' -o -name '*.h' | sort) -o "$podir/kation.pot"
