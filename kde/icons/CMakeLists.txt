# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

# Tray icons, one per sync state (Plasma's tray does not draw overlay icons):
# the cloud uses the theme's text colour, so Plasma recolours it for the
# panel; the badge keeps its colour. Also the Dolphin "syncing" emblem, which
# Breeze does not have.
include(ECMInstallIcons)
file(GLOB KATION_ICONS "${CMAKE_CURRENT_SOURCE_DIR}/sc-*-kation-*.svg")
ecm_install_icons(ICONS ${KATION_ICONS} DESTINATION ${KDE_INSTALL_ICONDIR} THEME hicolor)
