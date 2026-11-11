# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

# Client-side proxy for kationd, generated from the shared interface XML.
set(_xml "${PROJECT_SOURCE_DIR}/dbus/com.hleroy.Kation.Drive1.xml")
set_source_files_properties("${_xml}" PROPERTIES
    INCLUDE kationtypes.h
    CLASSNAME KationDriveInterface
)
set(kation_dbus_SRCS kationtypes.cpp kationtexts.cpp kationweb.cpp)
qt_add_dbus_interface(kation_dbus_SRCS "${_xml}" kationdriveinterface)

add_library(kation_dbus STATIC ${kation_dbus_SRCS})
target_include_directories(kation_dbus PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}" "${CMAKE_CURRENT_BINARY_DIR}")
target_link_libraries(kation_dbus PUBLIC Qt6::Core Qt6::DBus PRIVATE Qt6::Gui KF6::I18n)
set_target_properties(kation_dbus PROPERTIES POSITION_INDEPENDENT_CODE ON)
