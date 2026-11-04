# Kation roadmap

Unofficial Proton Drive client for KDE Plasma.

## Architecture

- **Helper daemon** — TypeScript on Bun, built on Proton's official
  [Drive SDK](https://github.com/ProtonDriveApps/sdk) and reusing the
  authentication code from Proton Drive CLI. It owns everything Proton-related:
  login, encryption, file operations, remote change events and the sync engine.
  It exposes its features to the KDE side over D-Bus.
- **KDE front end** — C++ / Qt 6 / KDE Frameworks 6. Every user-facing part
  talks to the daemon over D-Bus and never to Proton directly.

## Initial release (done; tested on a desktop with a real Proton account)

**Foundations**

- Repository layout, build (Bun + CMake), CI.
- Our own `x-pm-appversion` identifier; follows Proton's guidelines for
  unofficial apps.
- Debian, Fedora and Arch packages built from the install rules
  (`./build-package.sh`), attached to each GitHub release.
- French translation; kationd reports pause and problem reasons as codes,
  worded on the KDE side.

**Proton Drive in Dolphin**

- Browser sign-in from the Kation window (Kation never sees the password);
  session stored in KWallet (libsecret); sign-out also ends the session on
  Proton's servers.
- Daemon: list, stat, download, upload, create folders, rename, move, delete
  (to the Proton trash); metadata cache. D-Bus activation starts `kationd` on
  first use.
- Folder listings cached and refreshed from Drive events; Dolphin views reload
  when files change elsewhere (KDirNotify). Drive event polling stops at
  sign-out and when Proton ends the session.
- KIO worker exposing `protondrive:/`, so the drive works in Dolphin and in the
  Open/Save dialogs of every KDE app. Listed under Network in Dolphin.

**Folder sync**

- Two-way sync between `~/Proton Drive` (configurable) and "My files": a file
  watcher for local changes, Drive events for remote ones. Off until turned on.
- Local state database (SQLite) recording what both sides looked like after
  the last sync; three-way comparison decides what to copy.
- Only folders named by Drive events are listed again; the whole tree is
  listed only for the first sync or when Drive asks for a refresh. Folders
  with pending remote changes survive restarts.
- Conflicts keep both versions; deletions go to the Proton trash or the
  desktop Trash; locally changed files survive a remote folder deletion.
- Safety pauses: missing or replaced sync folder (resumes when it is back),
  sync folder on a disk that is not mounted (starts when it is mounted),
  different account, more than 100 deletions at once, undecryptable names.
- Resumable transfers: interrupted downloads continue (checked against the
  SHA-1); uploads restart, as the SDK cannot continue them.
- Selective sync (folders to sync) and upload/download speed limits.
- Starts with the session while sync is on, stops at logout (systemd user
  service).
- Backoff on rate limits and network errors; sessions ended by Proton are
  reported.

**Plasma integration**

- System tray icon (StatusNotifierItem) with one icon per sync state; pause
  and resume, sync now, recent activity. The Kation app is a single instance
  living in the tray; it starts at login through an autostart entry
  (optional).
- KNotifications for conflicts (grouped), sync problems, safety pauses and
  sessions ended by Proton.
- Dolphin emblems showing each file's sync state, answered by kationd from
  local data.
- Dolphin context menu: copy the public link (view-only, created after
  asking), open in the Proton Drive website.
- System Settings module (KCM, Network category), sharing its widget with
  the Kation window: account, sync, folders to sync (tree), speed limits,
  tray at login.

## Roadmap (not prioritized)

Ideas for after the initial release, grouped by area. The order means
nothing yet.

**Sharing**

- Manage public links from the desktop: password, expiry, removal. (Kation
  can already show, create and copy a view-only link.)
- Share with people by email, and see what you shared ("Shared by me").
- "Shared with me": browse items others shared, accept or decline
  invitations.

**Trash and versions**

- Browse the Proton trash, restore items, delete for good, empty it.
  (Kation already sends every deletion to the Proton trash.)
- File versions: list them, open an old one, restore it. (Kation already
  makes each local edit a new version on Proton.)

**More of Proton Drive**

- Photos.
- KRunner search. The SDK's search is experimental; searching names in
  Kation's own cache and sync database is likely more reliable.
- Multiple accounts.

**Online view**

- Stream downloads to applications instead of downloading the whole file
  first (KIO `get`).
- Generate thumbnails on upload, as the Proton CLI does.

**Sync**

- Detect renames and moves instead of transferring the file again.
- Transfer several files in parallel (within Proton's limits).
- Warn when the folder has more subfolders than inotify can watch.
- Clean up partial downloads of files that were deleted remotely.
- Keep recent activity across restarts (it is in memory only).
- Speed limits are averages over all transfers; short bursts can exceed them.

**Release**

- Publish the packages: AUR, a Fedora COPR, an APT repository.
- More translations (French is done), user documentation.
- Optional: submit the project to KDE.

## Out of scope

- Files that appear locally but download only when opened. Everything that is
  synced is fully downloaded.
- Flatpak and Snap. Both sandbox the app, while most of Kation runs inside
  the system's own KDE programs: the `protondrive:/` KIO worker, the Dolphin
  emblems and context menu, and the System Settings module are plugins they
  load from the system's plugin folders. A sandboxed package can't install
  there, so it would offer only sync and the tray icon.

## Decisions

- Daemon language: **TypeScript** (Bun), so we can reuse the CLI's auth code.
- License: **GPL-2.0-or-later** (code copied from Proton stays MIT).
- App ID: **com.hleroy.Kation** (keyring entry and D-Bus names).
- Proton SDK: git submodule pinned to a release tag (currently `cli/v0.9.0`).
- Project name: **Kation** (German/Nordic word for "cation"; a proton is the
  simplest cation). Chosen to avoid Proton branding, per Proton's guidelines
  for third-party apps.

## Risks

- The SDK isn't ready for third-party production use and its API may change.
  We pin a fixed version.
- Proton plans an encryption model change for late 2026 / early 2027 that will
  break older SDK versions, so we must upgrade quickly when it lands.
- The SDK may only be used for personal, non-commercial projects.
- Proton may ship its own Linux sync client.
