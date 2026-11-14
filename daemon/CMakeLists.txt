# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

find_program(BUN_EXECUTABLE bun REQUIRED)

# package.json and CMake must agree on the version.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/package.json" _package_json)
string(JSON _package_version GET "${_package_json}" version)
if(NOT _package_version STREQUAL PROJECT_VERSION)
    message(FATAL_ERROR "daemon/package.json version ${_package_version} differs from project version ${PROJECT_VERSION}")
endif()

set(_install_stamp "${CMAKE_CURRENT_BINARY_DIR}/bun-install.stamp")
add_custom_command(
    OUTPUT "${_install_stamp}"
    COMMAND "${BUN_EXECUTABLE}" install --frozen-lockfile
    COMMAND "${CMAKE_COMMAND}" -E touch "${_install_stamp}"
    DEPENDS package.json bun.lock
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
    COMMENT "Installing kationd dependencies"
    VERBATIM
)

file(GLOB_RECURSE _daemon_sources CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/src/*.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/scripts/*.ts"
)
set(_kationd "${CMAKE_CURRENT_BINARY_DIR}/kationd")
add_custom_command(
    OUTPUT "${_kationd}"
    COMMAND "${CMAKE_COMMAND}" -E env "KATION_VERSION=${PROJECT_VERSION}"
            "${BUN_EXECUTABLE}" ./scripts/build.ts --outfile "${_kationd}"
    DEPENDS "${_install_stamp}" ${_daemon_sources} tsconfig.json
            "${PROJECT_SOURCE_DIR}/dbus/com.hleroy.Kation.Drive1.xml"
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
    COMMENT "Building kationd"
    VERBATIM
)
add_custom_target(kationd-build ALL DEPENDS "${_kationd}")

install(PROGRAMS "${_kationd}" DESTINATION "${CMAKE_INSTALL_BINDIR}")

if(BUILD_TESTING)
    add_test(NAME kationd-unit COMMAND "${BUN_EXECUTABLE}" test WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
    add_test(NAME proton-copy COMMAND "${BUN_EXECUTABLE}" ./scripts/protonCopy.ts check WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
    add_test(NAME kationd-types COMMAND "${BUN_EXECUTABLE}" x tsc --noEmit -p . WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
    add_test(NAME kationd-runs COMMAND "${_kationd}" version)
    add_test(NAME kationd-isolated COMMAND "${BUN_EXECUTABLE}" ./scripts/checkIsolation.ts "${_kationd}" WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
endif()
