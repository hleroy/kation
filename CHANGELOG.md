# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Signed out after a reboot when the keyring was still locked as kationd started: kationd now signs in as soon as the keyring unlocks.

## [0.1.0] - 2026-11-02

Initial release; its scope is in [ROADMAP.md](ROADMAP.md).

### Added

- Browser sign-in from the Kation window; the session is kept in the keyring (Secret Service).
- `protondrive:/` in Dolphin and the Open/Save dialogs: browse, copy, rename, move, create folders, delete to the Proton trash.
- Two-way folder sync with "My files", off until turned on; conflicts keep both versions.
- Safety pauses: missing or replaced sync folder, another account, more than 100 deletions at once.
- Resumable downloads, selective sync, and upload and download speed limits.
- System tray icon with one icon per sync state, notifications, and recent activity.
- Dolphin emblems for each file's sync state, and a context menu to copy a public link or open the website.
- System Settings module (Network → Proton Drive).
- French translation.
- Debian, Fedora and Arch packages: `./build-package.sh` builds one for the distribution it runs on.
- GitHub releases come with packages for Debian 13, Fedora 43 and Arch Linux.

[Unreleased]: https://github.com/hleroy/kation/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hleroy/kation/releases/tag/v0.1.0
