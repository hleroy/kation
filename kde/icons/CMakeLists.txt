# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

# The application icon, named after the app ID (freedesktop convention). Tray
# icons, one per sync state (Plasma's tray does not draw overlay icons): the K
# and cloud use the theme's text colour, so Plasma recolours them for the panel;
# the badge keeps its colour. kation-tray also marks Proton Drive places and
# actions. Also the Dolphin "syncing" emblem, which Breeze does not have.
include(ECMInstallIcons)
file(GLOB KATION_ICONS "${CMAKE_CURRENT_SOURCE_DIR}/sc-*.svg")
ecm_install_icons(ICONS ${KATION_ICONS} DESTINATION ${KDE_INSTALL_ICONDIR} THEME hicolor)
