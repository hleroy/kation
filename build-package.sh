#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

# Clean build of Kation and a package for this distribution in dist/: a .deb
# (Debian and derivatives), an .rpm (Fedora) or an Arch package, all made from
# the CMake install rules (see cmake/KationPackaging.cmake).

set -euo pipefail
# Packages keep the staged directories' modes; with a group-writable umask
# (Fedora's default) the .rpm conflicts with the packages that own them.
umask 022

if [ -t 1 ]; then
    RED=$'\033[0;31m'
    GREEN=$'\033[0;32m'
    YELLOW=$'\033[1;33m'
    NC=$'\033[0m'
else
    RED='' GREEN='' YELLOW='' NC=''
fi

print_info() { echo "${GREEN}[INFO]${NC} $1"; }
print_warning() { echo "${YELLOW}[WARN]${NC} $1"; }
print_error() { echo "${RED}[ERROR]${NC} $1" >&2; }
print_step() { echo; echo "${GREEN}==>${NC} $1"; }

check_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        print_error "Required command '$1' not found ($2)."
        exit 1
    fi
}

show_help() {
    cat <<EOF
Usage: $0 [OPTIONS]

Build Kation from scratch and package it in dist/ for this distribution:
  Debian and derivatives  .deb
  Fedora                  .rpm
  Arch Linux              .pkg.tar.zst

OPTIONS:
    -h, --help      Show this help
    -v, --verbose   Show every command

The version comes from project(VERSION) in CMakeLists.txt. The package targets
the distribution it is built on: build it on the system you install it on.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        -h | --help)
            show_help
            exit 0
            ;;
        -v | --verbose)
            set -x
            shift
            ;;
        *)
            print_error "Unknown option: $1 (see --help)"
            exit 1
            ;;
    esac
done

detect_format() {
    local id
    if [ ! -r /etc/os-release ]; then
        print_error "Cannot identify the distribution: /etc/os-release is missing."
        exit 1
    fi
    # shellcheck source=/dev/null
    . /etc/os-release
    for id in ${ID:-} ${ID_LIKE:-}; do
        case "$id" in
            debian | ubuntu) echo deb && return ;;
            fedora) echo rpm && return ;;
            arch) echo arch && return ;;
        esac
    done
    print_error "Unsupported distribution '${PRETTY_NAME:-unknown}': packages are built for Debian and derivatives, Fedora and Arch Linux."
    exit 1
}

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SOURCE_DIR/build-package"
DIST_DIR="$SOURCE_DIR/dist"
FORMAT="$(detect_format)"

print_step "Checking prerequisites ($FORMAT package)"
check_command cmake "package cmake"
check_command bun "https://bun.sh"
case "$FORMAT" in
    deb)
        check_command cpack "package cmake"
        check_command dpkg-shlibdeps "package dpkg-dev"
        check_command file "package file"
        ;;
    rpm)
        check_command cpack "package cmake"
        check_command rpmbuild "package rpm-build"
        ;;
    arch)
        check_command makepkg "package pacman"
        check_command fakeroot "package fakeroot"
        if [ "$(id -u)" -eq 0 ]; then
            print_error "makepkg does not run as root: run $0 as a normal user."
            exit 1
        fi
        ;;
esac
if [ ! -f "$SOURCE_DIR/third_party/proton-drive-sdk/client/js/package.json" ]; then
    print_error "The Proton Drive SDK submodule is missing. Run: git submodule update --init"
    exit 1
fi

print_step "Configuring a clean build in $BUILD_DIR"
rm -rf "$BUILD_DIR"
cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=/usr \
    -DBUILD_TESTING=OFF

print_step "Building"
cmake --build "$BUILD_DIR" --parallel

print_step "Packaging"
shopt -s nullglob
case "$FORMAT" in
    deb)
        (cd "$BUILD_DIR" && cpack -G DEB)
        packages=("$BUILD_DIR"/packages/*.deb)
        ;;
    rpm)
        (cd "$BUILD_DIR" && cpack -G RPM)
        packages=("$BUILD_DIR"/packages/*.rpm)
        ;;
    arch)
        mkdir -p "$BUILD_DIR/arch/work" "$BUILD_DIR/packages"
        (cd "$BUILD_DIR/arch" &&
            BUILDDIR="$BUILD_DIR/arch/work" PKGDEST="$BUILD_DIR/packages" \
                SRCDEST="$BUILD_DIR/arch/work" LOGDEST="$BUILD_DIR/arch/work" \
                PKGEXT=.pkg.tar.zst makepkg --force --noconfirm --nodeps)
        packages=("$BUILD_DIR"/packages/*.pkg.tar.zst)
        ;;
esac
if [ ${#packages[@]} -ne 1 ]; then
    print_error "Expected one package in $BUILD_DIR/packages, found ${#packages[@]}."
    exit 1
fi
mkdir -p "$DIST_DIR"
cp "${packages[0]}" "$DIST_DIR/"
PACKAGE="${DIST_DIR#"$SOURCE_DIR"/}/$(basename "${packages[0]}")"

case "$FORMAT" in
    deb) INSTALL_COMMAND="sudo apt install ./$PACKAGE" ;;
    rpm) INSTALL_COMMAND="sudo dnf install ./$PACKAGE" ;;
    arch) INSTALL_COMMAND="sudo pacman -U $PACKAGE" ;;
esac

print_step "Done"
print_info "Package: $PACKAGE"
print_warning "It targets this distribution; build it again on the system you install it on."
cat <<EOF

Install it (replacing a 'sudo cmake --install' install: remove that first with
  xargs -d '\\n' sudo rm -f < build/install_manifest.txt):
    $INSTALL_COMMAND

Then, in your session:
    systemctl --user daemon-reload
    kquitapp6 dolphin     # Dolphin loads the emblems and context menu on start
    kation &
EOF
