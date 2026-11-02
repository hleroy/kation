# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

# D-Bus activation: the first call to com.hleroy.Kation starts kationd.
configure_file(com.hleroy.Kation.service.in "${CMAKE_CURRENT_BINARY_DIR}/com.hleroy.Kation.service" @ONLY)
install(FILES "${CMAKE_CURRENT_BINARY_DIR}/com.hleroy.Kation.service" DESTINATION ${KDE_INSTALL_DBUSSERVICEDIR})

# systemd user unit: starts with the graphical session (when enabled) and stops at logout.
configure_file(kationd.service.in "${CMAKE_CURRENT_BINARY_DIR}/kationd.service" @ONLY)
install(FILES "${CMAKE_CURRENT_BINARY_DIR}/kationd.service" DESTINATION ${KDE_INSTALL_SYSTEMDUSERUNITDIR})

install(FILES com.hleroy.Kation.desktop DESTINATION ${KDE_INSTALL_APPDIR})
# Entry under "Network" in Dolphin.
install(FILES kation-remoteview.desktop DESTINATION ${KDE_INSTALL_DATADIR}/remoteview RENAME kation.desktop)
