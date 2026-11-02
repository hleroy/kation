# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

# Sync state emblems on files (Dolphin, file dialogs).
kcoreaddons_add_plugin(kationoverlay SOURCES overlayplugin.cpp INSTALL_NAMESPACE "kf6/overlayicon")
target_link_libraries(kationoverlay PRIVATE kation_dbus KF6::KIOCore)

# "Proton Drive" submenu in Dolphin's context menu.
kcoreaddons_add_plugin(kationfileitemaction SOURCES fileitemaction.cpp INSTALL_NAMESPACE "kf6/kfileitemaction")
target_link_libraries(kationfileitemaction PRIVATE kation_dbus Qt6::Widgets KF6::KIOWidgets KF6::I18n KF6::Notifications KF6::CoreAddons)
