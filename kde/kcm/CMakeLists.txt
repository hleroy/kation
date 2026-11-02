# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

# System Settings module (Network category).
kcoreaddons_add_plugin(kcm_kation SOURCES kcm_kation.cpp INSTALL_NAMESPACE "plasma/kcms/systemsettings_qwidgets")
target_link_libraries(kcm_kation PRIVATE kation_settings KF6::KCMUtils KF6::CoreAddons)
# A desktop file, so the module is found by search and can be opened with "kcmshell6 kcm_kation".
kcmutils_generate_desktop_file(kcm_kation)
