# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

# Distribution packages, made from what the install() rules install: anything
# that `cmake --install` puts on disk is in the package, and nothing else. CPack
# makes the .deb and the .rpm; makepkg makes the Arch package from the PKGBUILD
# generated below. Build them with ./build-package.sh.

install(FILES
    "${PROJECT_SOURCE_DIR}/README.md"
    "${PROJECT_SOURCE_DIR}/CHANGELOG.md"
    "${PROJECT_SOURCE_DIR}/packaging/copyright"
    DESTINATION "${CMAKE_INSTALL_DATAROOTDIR}/doc/kation"
)
install(FILES
    "${PROJECT_SOURCE_DIR}/LICENSES/GPL-2.0-or-later.txt"
    "${PROJECT_SOURCE_DIR}/LICENSES/MIT.txt"
    "${PROJECT_SOURCE_DIR}/LICENSES/LGPL-3.0-or-later.txt"
    DESTINATION "${CMAKE_INSTALL_DATAROOTDIR}/licenses/kation"
)

# Package scripts: each is packaging/user-sessions.sh followed by a short body,
# so that upgrades restart kationd in the running sessions and removals stop it.
# They are package metadata, not installed files.
set(KATION_PACKAGE_SCRIPTS_DIR "${PROJECT_BINARY_DIR}/packaging")
file(READ "${PROJECT_SOURCE_DIR}/packaging/user-sessions.sh" _kation_user_sessions)
function(kation_package_script body output)
    file(READ "${PROJECT_SOURCE_DIR}/packaging/${body}" _body)
    file(WRITE "${KATION_PACKAGE_SCRIPTS_DIR}/${output}"
        "#!/bin/sh\n# Generated from packaging/user-sessions.sh and packaging/${body} by cmake/KationPackaging.cmake.\n\n"
        "${_kation_user_sessions}\n${_body}")
    file(CHMOD "${KATION_PACKAGE_SCRIPTS_DIR}/${output}"
        PERMISSIONS OWNER_READ OWNER_WRITE OWNER_EXECUTE GROUP_READ GROUP_EXECUTE WORLD_READ WORLD_EXECUTE)
    set_property(DIRECTORY "${PROJECT_SOURCE_DIR}" APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
        "${PROJECT_SOURCE_DIR}/packaging/user-sessions.sh" "${PROJECT_SOURCE_DIR}/packaging/${body}")
endfunction()
kation_package_script(deb/postinst.sh deb/postinst)
kation_package_script(deb/prerm.sh deb/prerm)
kation_package_script(rpm/posttrans.sh rpm/posttrans)
kation_package_script(rpm/preun.sh rpm/preun)
# makepkg reads the install script next to the PKGBUILD.
kation_package_script(arch/kation.install.sh ../arch/kation.install)

set(CPACK_GENERATOR DEB RPM)
set(CPACK_PACKAGE_NAME kation)
set(CPACK_PACKAGE_VERSION "${PROJECT_VERSION}")
set(CPACK_PACKAGE_CONTACT "Hervé Le Roy <hleroy@hleroy.com>")
set(CPACK_PACKAGE_VENDOR "Kation contributors")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "Unofficial Proton Drive client for KDE Plasma")
set(CPACK_PACKAGE_DESCRIPTION "Kation brings Proton Drive to KDE Plasma. It is not affiliated with or endorsed by Proton AG.

- Online view: “My files” at protondrive:/ in Dolphin and in the Open/Save dialogs of KDE applications.
- Folder sync: keeps a local folder and “My files” identical, in both directions.
- System tray icon, System Settings module, and Dolphin emblems and context menu.")
set(CPACK_PACKAGE_DIRECTORY "${PROJECT_BINARY_DIR}/packages")
set(CPACK_DEBIAN_FILE_NAME DEB-DEFAULT)
set(CPACK_DEBIAN_PACKAGE_SECTION net)
set(CPACK_DEBIAN_PACKAGE_HOMEPAGE "https://github.com/hleroy/kation")

# Library dependencies come from dpkg-shlibdeps. kationd loads libsecret at run
# time (Bun.secrets), which shlibdeps cannot see; the systemd user unit and D-Bus
# activation need a per-user session bus.
set(CPACK_DEBIAN_PACKAGE_SHLIBDEPS ON)
set(CPACK_DEBIAN_PACKAGE_DEPENDS "libsecret-1-0, dbus-user-session")
set(CPACK_DEBIAN_PACKAGE_RECOMMENDS "dolphin, systemsettings, kwallet6 | gnome-keyring")

# Never strip: `bun build --compile` appends the JavaScript to the kationd
# executable, and stripping it removes the program.
set(CPACK_STRIP_FILES OFF)
set(CPACK_DEBIAN_PACKAGE_CONTROL_STRICT_PERMISSION ON)
set(CPACK_DEBIAN_PACKAGE_CONTROL_EXTRA "${KATION_PACKAGE_SCRIPTS_DIR}/deb/postinst;${KATION_PACKAGE_SCRIPTS_DIR}/deb/prerm")

# RPM (Fedora). Library dependencies come from rpmbuild's automatic Requires;
# libsecret is loaded at run time, as above. rpmbuild strips binaries and splits
# debug info by default, which would remove kationd's program.
set(CPACK_RPM_FILE_NAME RPM-DEFAULT)
set(CPACK_RPM_PACKAGE_RELEASE_DIST ON)
set(CPACK_PACKAGE_RELOCATABLE OFF)
set(CPACK_RPM_PACKAGE_LICENSE "GPL-2.0-or-later AND MIT AND LGPL-3.0-or-later")
set(CPACK_RPM_PACKAGE_URL "https://github.com/hleroy/kation")
set(CPACK_RPM_PACKAGE_DESCRIPTION "${CPACK_PACKAGE_DESCRIPTION}")
set(CPACK_RPM_PACKAGE_REQUIRES "libsecret")
set(CPACK_RPM_PACKAGE_SUGGESTS "dolphin, plasma-systemsettings, kf6-kwallet")
set(CPACK_RPM_POST_TRANS_SCRIPT_FILE "${KATION_PACKAGE_SCRIPTS_DIR}/rpm/posttrans")
set(CPACK_RPM_PRE_UNINSTALL_SCRIPT_FILE "${KATION_PACKAGE_SCRIPTS_DIR}/rpm/preun")
set(CPACK_RPM_SPEC_MORE_DEFINE "%global __strip /bin/true
%global debug_package %{nil}")

# Arch: ./build-package.sh runs makepkg on this PKGBUILD, which packages this
# build tree.
configure_file("${PROJECT_SOURCE_DIR}/packaging/arch/PKGBUILD.in" "${PROJECT_BINARY_DIR}/arch/PKGBUILD" @ONLY)

include(CPack)
