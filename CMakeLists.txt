# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

cmake_minimum_required(VERSION 3.22)

# C++ is for the KDE components (Qt 6 / KDE Frameworks 6).
project(kation VERSION 0.1.0 LANGUAGES CXX)

option(BUILD_KDE_COMPONENTS "Build the KDE components (needs Qt 6 and KDE Frameworks 6)" ON)

if(BUILD_KDE_COMPONENTS)
    find_package(ECM 6.0 REQUIRED NO_MODULE)
    list(APPEND CMAKE_MODULE_PATH ${ECM_MODULE_PATH})
    include(KDEInstallDirs)
    include(KDECMakeSettings)
    include(KDECompilerSettings NO_POLICY_SCOPE)
    include(ECMQtDeclareLoggingCategory)
    include(FeatureSummary)
else()
    include(GNUInstallDirs)
endif()
include(CTest)

if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/proton-drive-sdk/client/js/package.json")
    message(FATAL_ERROR "The Proton Drive SDK submodule is missing. Run: git submodule update --init")
endif()

add_subdirectory(daemon)

if(BUILD_KDE_COMPONENTS)
    add_subdirectory(kde)
    feature_summary(WHAT ALL FATAL_ON_MISSING_REQUIRED_PACKAGES)
endif()

include(cmake/KationPackaging.cmake)
