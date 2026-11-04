# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

# The application icon, named after the app ID (freedesktop convention). Tray
# icons, one per sync state (Plasma's tray does not draw overlay icons): the K
# and cloud use the theme's text colour, so Plasma recolours them for the panel;
# the badge keeps its colour. kation-folder marks the synced folder and the
# Proton Drive places, built like Breeze's folder-gdrive: the glyph alone at
# 16-24 px, Breeze's folder with the glyph from 32 px. Not "folder-kation":
# KIconLoader would fall back to the theme's plain "folder" before looking in
# hicolor. Also the Dolphin "syncing" emblem, which Breeze does not have.
include(ECMInstallIcons)
file(GLOB KATION_ICONS "${CMAKE_CURRENT_SOURCE_DIR}/*.svg")
ecm_install_icons(ICONS ${KATION_ICONS} DESTINATION ${KDE_INSTALL_ICONDIR} THEME hicolor)
