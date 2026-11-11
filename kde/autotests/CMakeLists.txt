# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

find_program(DBUS_RUN_SESSION dbus-run-session REQUIRED)

# The test starts the kationd built by this project, unless told otherwise.
set(KATIOND_EXECUTABLE "${CMAKE_BINARY_DIR}/daemon/kationd" CACHE FILEPATH "kationd used by the KIO integration test")

# Tests that check English texts run in English: the desktop may be in another
# language with Kation's catalog installed.
set(_english "LANGUAGE=en")

add_executable(kationtextstest kationtextstest.cpp)
target_link_libraries(kationtextstest PRIVATE kation_dbus Qt6::Test)
add_test(NAME kation-texts COMMAND kationtextstest syncReasons safetyPause problems webUrls)
set_tests_properties(kation-texts PROPERTIES ENVIRONMENT "${_english}")
# The French catalog compiled by ki18n_install (kde/CMakeLists.txt) in this build.
# gettext ignores LANGUAGE under the C locale, so any installed locale is set.
add_test(NAME kation-texts-fr COMMAND kationtextstest french)
set_tests_properties(kation-texts-fr PROPERTIES ENVIRONMENT "LC_ALL=en_US.UTF-8;LANGUAGE=fr;XDG_DATA_DIRS=${CMAKE_BINARY_DIR}/kde")
add_dependencies(kationtextstest pofiles)

# po/ matches the sources, and every translation is complete and compiles.
find_program(MSGCMP_EXECUTABLE msgcmp REQUIRED)
add_test(NAME po-check COMMAND "${PROJECT_SOURCE_DIR}/po/update.sh" --check)

add_executable(mimetypestest mimetypestest.cpp ../kioworker/mimetypes.cpp)
target_include_directories(mimetypestest PRIVATE ../kioworker)
target_link_libraries(mimetypestest PRIVATE Qt6::Test)
add_test(NAME kio-mime-types COMMAND mimetypestest)

add_executable(kioworkertest kioworkertest.cpp)
target_link_libraries(kioworkertest PRIVATE kation_dbus Qt6::Test KF6::KIOCore)
target_compile_definitions(kioworkertest PRIVATE KATIOND_EXECUTABLE="${KATIOND_EXECUTABLE}")
add_dependencies(kioworkertest kio_protondrive kationd-build)

# A private session bus, and the worker plugin from the build tree.
add_test(NAME kio-protondrive COMMAND "${DBUS_RUN_SESSION}" -- "$<TARGET_FILE:kioworkertest>")
set_tests_properties(kio-protondrive PROPERTIES
    ENVIRONMENT "QT_PLUGIN_PATH=${CMAKE_BINARY_DIR}/plugins;QT_QPA_PLATFORM=offscreen;${_english}"
    TIMEOUT 300
)

add_executable(settingswidgettest settingswidgettest.cpp)
target_link_libraries(settingswidgettest PRIVATE kation_settings Qt6::Test Qt6::Widgets KF6::KCMUtils KF6::CoreAddons)
target_compile_definitions(settingswidgettest PRIVATE
    KATION_TRAY_EXECUTABLE="${KDE_INSTALL_FULL_BINDIR}/kation"
    KATIOND_EXECUTABLE="${KATIOND_EXECUTABLE}"
    KATION_KCM_PLUGIN="$<TARGET_FILE:kcm_kation>"
)
add_dependencies(settingswidgettest kationd-build kcm_kation)
add_test(NAME settings-widget COMMAND "${DBUS_RUN_SESSION}" -- "$<TARGET_FILE:settingswidgettest>")
set_tests_properties(settings-widget PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen;${_english}" TIMEOUT 120)

add_executable(traytest traytest.cpp ../app/tray.cpp)
target_include_directories(traytest PRIVATE ../app)
target_link_libraries(traytest PRIVATE kation_dbus Qt6::Test Qt6::Widgets
    KF6::I18n KF6::KIOGui KF6::KIOWidgets KF6::Notifications KF6::StatusNotifierItem)
target_compile_definitions(traytest PRIVATE
    KATIOND_EXECUTABLE="${KATIOND_EXECUTABLE}"
    KATION_ICONS_DIR="${PROJECT_SOURCE_DIR}/kde/icons"
)
add_dependencies(traytest kationd-build)
add_test(NAME tray COMMAND "${DBUS_RUN_SESSION}" -- "$<TARGET_FILE:traytest>")
set_tests_properties(tray PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen;${_english}" TIMEOUT 120)

add_executable(dolphinpluginstest dolphinpluginstest.cpp)
target_link_libraries(dolphinpluginstest PRIVATE kation_dbus Qt6::Test Qt6::Widgets KF6::KIOCore KF6::KIOWidgets KF6::CoreAddons)
target_compile_definitions(dolphinpluginstest PRIVATE
    KATIOND_EXECUTABLE="${KATIOND_EXECUTABLE}"
    KATION_OVERLAY_PLUGIN="$<TARGET_FILE:kationoverlay>"
    KATION_FILEITEMACTION_PLUGIN="$<TARGET_FILE:kationfileitemaction>"
    KATION_FILEITEMACTION_JSON="${PROJECT_SOURCE_DIR}/kde/dolphin/kationfileitemaction.json"
    # Holds kf6/kfileitemaction/ with this build's plugin.
    KATION_PLUGIN_ROOT="$<TARGET_FILE_DIR:kationfileitemaction>/../.."
    KATION_ICONS_DIR="${PROJECT_SOURCE_DIR}/kde/icons"
)
add_dependencies(dolphinpluginstest kationd-build kationoverlay kationfileitemaction)
add_test(NAME dolphin-plugins COMMAND "${DBUS_RUN_SESSION}" -- "$<TARGET_FILE:dolphinpluginstest>")
set_tests_properties(dolphin-plugins PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen;${_english}" TIMEOUT 120)
