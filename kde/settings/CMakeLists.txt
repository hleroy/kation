# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

# Settings widget shared by the Kation window and the System Settings module.
add_library(kation_settings STATIC settingswidget.cpp trayautostart.cpp)
target_include_directories(kation_settings PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(kation_settings
    PUBLIC kation_dbus Qt6::Widgets
    PRIVATE KF6::ConfigCore KF6::I18n KF6::KIOGui KF6::KIOWidgets
)
set_target_properties(kation_settings PROPERTIES POSITION_INDEPENDENT_CODE ON)
# The tray's autostart entry names the installed program, so it does not depend on PATH.
target_compile_definitions(kation_settings PRIVATE KATION_TRAY_EXECUTABLE="${KDE_INSTALL_FULL_BINDIR}/kation")
