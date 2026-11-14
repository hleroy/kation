# Developer notes

How to build Kation from source, work on it and release it. For what Kation
does and how to use it, see [README.md](README.md); for what is planned, see
[ROADMAP.md](ROADMAP.md).

## Architecture

```
Dolphin / file dialogs ──KIO──▶ kio_protondrive ─┐
Dolphin emblems and context menu (plugins) ──────┤
Kation tray, window, System Settings ────────────┼─D-Bus─▶ kationd ──▶ Proton Drive SDK ──▶ Proton
                                                 ┘         (session in KWallet)
```

- **`kationd`** (`daemon/`), a background service written in TypeScript and
  run by Bun. It uses Proton's official
  [Drive SDK](https://github.com/ProtonDriveApps/sdk) (the
  `third_party/proton-drive-sdk` submodule) for all Proton work: sign-in,
  encryption, file operations and change events. D-Bus starts it on first
  use.
- **The KDE side** (`kde/`): `kio_protondrive`, the KIO worker behind
  `protondrive:/`; `kation`, the tray icon and settings window; the System
  Settings module; and two Dolphin plugins. They are written in C++ with Qt 6
  and KDE Frameworks 6, and none of them talks to Proton directly.
- The D-Bus interface between them is described in
  [dbus/com.hleroy.Kation.Drive1.xml](dbus/com.hleroy.Kation.Drive1.xml).
  kationd serves it on the session bus only and trusts every caller there:
  any program running as the user can call any method, including `Upload`
  and `Download` with any local path. That gives such a program nothing it
  could not already do, since it can read the user's files and keyring
  directly. Checking callers' bus names would not help, as any program can
  own any name on the session bus. Sandboxed apps (Flatpak) reach kationd
  only when granted `--talk-name=com.hleroy.Kation` or the whole session
  bus. Never serve the interface beyond the session bus.

## Getting the source and the dependencies

```sh
git clone --recurse-submodules https://github.com/hleroy/kation.git
cd kation
```

Requirements: Git, CMake 3.22+, a C++ compiler, extra-cmake-modules, Qt 6.6+,
KDE Frameworks 6 (KIO, CoreAddons, I18n, Config, DBusAddons, KCMUtils,
Notifications, StatusNotifierItem, WindowSystem), D-Bus, [Bun](https://bun.sh)
1.4.2+, and libsecret with a Secret Service provider (KWallet or GNOME
Keyring) at runtime. Arch packages Bun; on Debian and Fedora, install it
from [bun.sh](https://bun.sh).

On Debian 13 and Debian derivatives with Plasma 6 (such as KDE neon):

```sh
sudo apt install git cmake g++ make extra-cmake-modules gettext \
    qt6-base-dev libkf6kio-dev libkf6coreaddons-dev libkf6i18n-dev \
    libkf6config-dev libkf6dbusaddons-dev libkf6kcmutils-dev \
    libkf6notifications-dev libkf6statusnotifieritem-dev libkf6windowsystem-dev
```

On Fedora:

```sh
sudo dnf install git cmake gcc-c++ make extra-cmake-modules gettext qt6-qtbase-devel \
    kf6-kio-devel kf6-kcoreaddons-devel kf6-ki18n-devel kf6-kconfig-devel \
    kf6-kdbusaddons-devel kf6-kcmutils-devel kf6-knotifications-devel \
    kf6-kstatusnotifieritem-devel kf6-kwindowsystem-devel
```

On Arch Linux:

```sh
sudo pacman -S --needed base-devel git cmake extra-cmake-modules gettext bun \
    qt6-base kio kcoreaddons ki18n kconfig kdbusaddons kcmutils knotifications \
    kstatusnotifieritem kwindowsystem libsecret
```

## Building and installing from source

Build, test and install system-wide (KIO, Dolphin and System Settings only
find plugins in Qt's plugin folder, hence `/usr`):

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX=/usr
cmake --build build
ctest --test-dir build --output-on-failure    # about 2.5 minutes
sudo cmake --install build
systemctl --user daemon-reload
```

To uninstall: `sudo xargs -d '\n' rm -f < build/install_manifest.txt`.

The build downloads JavaScript dependencies with `bun install`, so it needs
network access. Pass `-DBUILD_KDE_COMPONENTS=OFF` to build only `kationd`.

## Building a package

`./build-package.sh` builds a package in `dist/` for the distribution it
runs on: a `.deb` on Debian 13 and Debian derivatives with Plasma 6, an
`.rpm` on Fedora, and a `.pkg.tar.zst` on Arch Linux. Packages are made
from the CMake install rules (`cmake/KationPackaging.cmake`,
`packaging/arch/PKGBUILD.in`) and depend on the library versions of the
system they are built on, so build on the system you install on. Besides
the build dependencies above, it needs `dpkg-dev` and `file` on Debian,
`rpm-build` on Fedora, and nothing more on Arch (run it as a normal user
there: makepkg refuses to run as root).

```sh
./build-package.sh
sudo apt install ./dist/kation_*.deb         # Debian and derivatives
sudo dnf install ./dist/kation-*.rpm         # Fedora
sudo pacman -U dist/kation-*.pkg.tar.zst     # Arch Linux
systemctl --user daemon-reload
```

If Kation was installed with `sudo cmake --install`, remove that install
first so the package owns every file. CI builds the three packages for
every pull request (the `kation-debian13-deb`, `kation-fedora43-rpm` and
`kation-arch-pkg` artifacts).

## Development setup

Install the git hooks once per clone. They run the formatters and linters
before each commit, check the commit message, and run `bun test` before a
push:

```sh
pipx install pre-commit      # or: uv tool install pre-commit
pre-commit install
pre-commit run --all-files
```

Use a current pre-commit rather than your distribution's package. CI
installs the latest one, and an older pre-commit can decide differently
which files a hook checks: Ubuntu's 3.6.2 does not treat `PKGBUILD.in` as a
shell script, so shellcheck passes locally and fails in CI. `which
pre-commit` should show `~/.local/bin/pre-commit`.

A green pre-commit run is not a passing test suite: run `ctest` before
committing a code change.

### kationd

```sh
cd daemon
bun install
bun run dev -- serve --fake-drive --verbose   # D-Bus service on a simulated drive
bun test
bun run check-types
```

`kationd serve --fake-drive` serves an in-memory drive with no network
access; the KDE tests (`ctest`) use it to run real KIO jobs end to end.
Set `KATION_SCREENSHOT_DIR` to get screenshots of the settings from its
test.

After updating the `third_party/proton-drive-sdk` submodule, run
`bun install` again: Bun keeps its own copy of the SDK in `node_modules`.

`daemon/src/proton/` holds code copied from the Proton Drive CLI in that
submodule. It is never edited by hand: its
[README](daemon/src/proton/README.md) lists the two changes Kation makes and
the steps to move to a newer CLI release, and ctest's `proton-copy` fails when
the copy differs from upstream in any other way.

### End-to-end tests

[docs/e2e-test-plan.md](docs/e2e-test-plan.md) drives a run against a real
Proton **test** account (`bun e2e/realAccount.ts --expect-email …`).

## Contributing

- Work on a branch named `<type>/<short-description>` and open a pull
  request. Pull requests are squash-merged: the title becomes the commit on
  `main`.
- Commit messages and pull request titles follow
  [Conventional Commits](https://www.conventionalcommits.org/):
  `<type>[optional scope]: <description>`, lowercase and imperative. Types:
  `feat fix refactor chore docs test style perf ci build revert`.
- Add a line to `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for every
  user-visible change.
- The D-Bus interface XML, `daemon/src/service/dbusServer.ts` and
  `daemon/test/dbusContract.test.ts` change together.
- Every string the KDE side shows goes through `i18n()`. After changing
  strings, run `po/update.sh` and translate the new entries in
  `po/fr/kation.po`; ctest's `po-check` fails otherwise.
- Every new file gets SPDX headers, or an entry in `REUSE.toml` when it
  cannot carry a comment.

## Releasing

1. Refresh the CI container digests (`debian:trixie`, `fedora:43`,
   `archlinux:latest` in `ci.yml` and `packages.yml`). They are pinned by
   digest, which Dependabot does not update: run the command in the comment
   next to each (`docker buildx imagetools inspect <image>`) and copy the new
   digest.
2. Bump `project(VERSION)` in `CMakeLists.txt` and `version` in
   `daemon/package.json` (CMake checks that they match).
3. Rename `[Unreleased]` in `CHANGELOG.md` to `[x.y.z] - YYYY-MM-DD`, with a
   compare link.
4. Merge that, then tag the merged commit on `main` `vx.y.z` and push the
   tag.

The Release workflow checks that the tag is on `main` and matches the
version and the changelog, builds the three packages and publishes a GitHub
release with the changelog section as notes, `SHA256SUMS` and a build
provenance attestation for each package. To redo a release, delete it
and its tag first (`gh release delete vx.y.z --cleanup-tag`): the workflow
fails when the release already exists.
