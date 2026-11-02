# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

kcoreaddons_add_plugin(kio_protondrive INSTALL_NAMESPACE "kf6/kio")
target_sources(kio_protondrive PRIVATE
    protondriveworker.cpp
    errors.cpp
)
ecm_qt_declare_logging_category(kio_protondrive
    HEADER logging.h
    IDENTIFIER KATION_KIO
    CATEGORY_NAME kation.kio
    DESCRIPTION "Kation KIO worker"
    EXPORT KATION
)
target_link_libraries(kio_protondrive PRIVATE kation_dbus KF6::KIOCore KF6::I18n Qt6::DBus)

# Tests load the worker from the build tree.
set_target_properties(kio_protondrive PROPERTIES LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/plugins/kf6/kio")
