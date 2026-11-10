# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- `kationd` no longer runs code or reads settings from the folder it is started in (`bunfig.toml`, `.env`, `node_modules`): a file planted in a synced or downloaded folder could run code when a `kationd` command was run there.
- `protondrive:/` takes a file's type from its name, so a file such as `photo.jpg` no longer opens in the application for whatever type its uploader claimed (a Java archive, for example). A file whose name gives no type keeps its stored type only when that is plain text, Markdown or CSV; other such files show as unknown and open with "Open With".

### Fixed

- Sync no longer reads or writes through a symbolic link in the sync folder that has the name of an item in Proton Drive (it uploaded the link target's files and downloaded into it), nor trashes the Proton copy of a synced folder replaced by a link; it reports the link instead.

## [0.2.0] - 2026-11-05

### Added

- `scripts/disable-gnome-keyring.sh`: stops GNOME Keyring from taking over the Secret Service from KWallet when a dependency installed it (`--undo` restores it).
- Sync waits for the disk when the sync folder is on a disk that is not mounted, instead of syncing into its empty mount point, and starts once the disk is mounted.

### Changed

- kationd creates the sync folder only on a first sync and never its missing parent folders; a sync folder that disappeared is no longer recreated empty.
- New application icon: a K⁺ on a purple tile. The tray shows a K beside a cloud; the synced folder, `protondrive:/` and the online view show a folder with the same K and cloud, like Breeze's other folders.

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

[Unreleased]: https://github.com/hleroy/kation/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/hleroy/kation/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hleroy/kation/releases/tag/v0.1.0
