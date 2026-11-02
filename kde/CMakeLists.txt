# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

set(QT_MIN_VERSION 6.6.0)
set(KF_MIN_VERSION 6.0.0)

find_package(Qt6 ${QT_MIN_VERSION} REQUIRED COMPONENTS Core DBus Widgets)
find_package(KF6 ${KF_MIN_VERSION} REQUIRED COMPONENTS
    Config CoreAddons DBusAddons I18n KCMUtils KIO Notifications StatusNotifierItem WindowSystem
)
if(BUILD_TESTING)
    find_package(Qt6 ${QT_MIN_VERSION} REQUIRED COMPONENTS Test)
endif()

add_definitions(-DTRANSLATION_DOMAIN=\"kation\")
add_compile_definitions(
    QT_NO_CAST_FROM_ASCII
    QT_NO_CAST_TO_ASCII
    QT_NO_URL_CAST_FROM_STRING
    QT_USE_QSTRINGBUILDER
    KATION_VERSION_STRING="${PROJECT_VERSION}"
)

add_subdirectory(dbus)
add_subdirectory(settings)
add_subdirectory(kioworker)
add_subdirectory(app)
add_subdirectory(kcm)
add_subdirectory(dolphin)
add_subdirectory(data)
add_subdirectory(icons)

# Translations: po/<lang>/kation.po, compiled into locale/ of this build
# directory and installed. Update them with po/update.sh.
ki18n_install(${PROJECT_SOURCE_DIR}/po)

if(BUILD_TESTING)
    add_subdirectory(autotests)
endif()
