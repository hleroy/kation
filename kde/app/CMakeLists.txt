# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

add_executable(kation main.cpp tray.cpp)
target_link_libraries(kation PRIVATE
    kation_settings Qt6::Widgets
    KF6::ConfigCore KF6::CoreAddons KF6::DBusAddons KF6::I18n KF6::KIOGui KF6::KIOWidgets
    KF6::Notifications KF6::StatusNotifierItem KF6::WindowSystem
)
install(TARGETS kation ${KDE_INSTALL_TARGETS_DEFAULT_ARGS})
install(FILES kation.notifyrc DESTINATION ${KDE_INSTALL_KNOTIFYRCDIR})
