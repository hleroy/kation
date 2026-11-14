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

## Roadmap

Ranked in November 2026 by comparing Kation 0.3.0 with Proton's Windows and
macOS apps and with the most voted ideas on Proton's
[UserVoice](https://protonmail.uservoice.com/forums/932839-proton-drive/filters/top).

- **Must:** a gap in reliable file sync, or a feature users expect from any
  Proton Drive desktop client.
- **Should:** high value (the official apps have it, or more than about 500
  votes) and feasible with the SDK.
- **Could:** useful, with lower demand or a higher cost.
- **Minor:** small improvements, not part of the comparison.

W and M say whether the Windows and macOS apps have the feature (✓ yes,
◐ partly, — no, ? not confirmed). Votes are UserVoice votes for the related
ideas on 11 November 2026.

|   # | Feature                                     | Priority   |  W  |  M  |                   Votes | Notes                                                                                                                                                                                                    |
| --: | :------------------------------------------ | :--------- | :-: | :-: | ----------------------: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Rename and move detection                   | **Must**   |  ✓  |  ✓  |                       — | A local rename or move is transferred again as a new file, which loses its version history and public link.                                                                                              |
|   2 | Follow the SDK to the new encryption scheme | **Must**   |  ✓  |  ✓  |                       — | Older SDK versions will stop working (see Risks).                                                                                                                                                        |
|   3 | "Shared with me"                            | **Must**   |  ✓  |  ◐  |                     926 | Browse items others shared, accept or decline invitations, sync them.                                                                                                                                    |
|   4 | Sync any local folder                       | **Must**   |  ✓  |  ◐  |               436 + 419 | Documents, an external disk… Kation syncs one folder with "My files" only.                                                                                                                               |
|   5 | Storage quota                               | **Must**   |  ✓  |  ✓  |                       — | Show the space used and available, warn near the limit, and report a full account with its own problem code instead of a generic error.                                                                  |
|   6 | Photos import                               | **Should** |  ✓  |  —  |             1 668 + 939 | Import a local folder or a Google Takeout export into Photos.                                                                                                                                            |
|   7 | Exclusion patterns                          | **Should** |  —  |  —  |                     774 | `.gitignore`-style rules (`node_modules`, build output), on top of the folders to sync.                                                                                                                  |
|   8 | Detailed sync progress                      | **Should** |  ✓  |  ✓  |                     691 | The list of transfers with per-file progress. Kation shows the current path and the number of pending folders.                                                                                           |
|   9 | Parallel transfers                          | **Should** |  ?  |  ?  |                       — | Several files at once, within Proton's limits. One at a time is slow for many small files.                                                                                                               |
|  10 | Thumbnails on upload                        | **Should** |  ✓  |  ?  |                       — | As the Proton CLI does, so that uploaded files have a preview in the web and mobile apps.                                                                                                                |
|  11 | Package repositories                        | **Should** |  ✓  |  ✓  |                   2 130 | AUR, a Fedora COPR, an APT repository: updates through the system updater, where the official apps update themselves. Votes are for a Linux client.                                                      |
|  12 | Full resync                                 | **Should** |  —  |  ✓  |                       — | Rebuild the local state database without signing out.                                                                                                                                                    |
|  13 | Proton Docs and Sheets as links             | **Could**  |  ✓  |  ✓  |                       — | Links that open the web editor, in the sync folder and in `protondrive:/`. Kation skips these files today.                                                                                               |
|  14 | Timed pause                                 | **Could**  |  ✓  |  —  |                       — | Pause for a few hours or until the next day.                                                                                                                                                             |
|  15 | Sharing                                     | **Could**  |  —  |  ◐  |                     363 | Public links: password, expiry, removal (Kation already shows, creates and copies a view-only link). Share with people by email; "Shared by me".                                                         |
|  16 | KRunner search                              | **Could**  |  —  |  —  |               229 + 120 | The SDK's search is experimental; searching names in Kation's own cache and sync database is likely more reliable.                                                                                       |
|  17 | Folder sizes                                | **Could**  |  —  |  —  |                     564 | Sizes and item counts in Dolphin's Properties dialog.                                                                                                                                                    |
|  18 | Trash and versions                          | **Could**  |  —  |  —  |                     114 | Browse the Proton trash, restore, delete for good, empty it. List file versions, open or restore an old one. Kation already sends deletions to the Proton trash and makes each local edit a new version. |
|  19 | Access from non-KDE apps and scripts        | **Could**  |  —  |  —  | 1 021 + 704 + 409 + 264 | FUSE or WebDAV; the `kationd` commands cover part of it.                                                                                                                                                 |
|  20 | Multiple accounts                           | **Could**  |  —  |  —  |                       — |                                                                                                                                                                                                          |
|  21 | "Report a problem"                          | **Could**  |  ✓  |  ✓  |                       — | Collect the log and open a prefilled GitHub issue.                                                                                                                                                       |
|  22 | Streamed downloads                          | Minor      |     |     |                         | Stream to applications instead of downloading the whole file first (KIO `get`).                                                                                                                          |
|  23 | inotify limit warning                       | Minor      |     |     |                         | Warn when the folder has more subfolders than inotify can watch.                                                                                                                                         |
|  24 | Partial download cleanup                    | Minor      |     |     |                         | Remove partial downloads of files that were deleted remotely.                                                                                                                                            |
|  25 | Persistent recent activity                  | Minor      |     |     |                         | Keep it across restarts (it is in memory only).                                                                                                                                                          |
|  26 | Stricter speed limits                       | Minor      |     |     |                         | Limits are averages over all transfers; short bursts can exceed them.                                                                                                                                    |
|  27 | Translations and documentation              | Minor      |     |     |                         | More translations (French is done), user documentation.                                                                                                                                                  |
|  28 | Submit the project to KDE                   | Minor      |     |     |                         | Optional.                                                                                                                                                                                                |

## Out of scope

- Files that appear locally but download only when opened. Everything that is
  synced is fully downloaded. Linux has no system API for placeholders, so
  this would take a FUSE file system; `protondrive:/` and the folders to sync
  stand in for it. To revisit if users ask.
- Browsing and organizing photos (albums, search, duplicates) and editing
  Docs and Sheets: these belong to Proton's web and mobile apps.
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
- Proton plans an official Linux beta, likely a sync daemon without a
  desktop interface. Kation's distinct value would then be the Plasma
  integration (Dolphin, KIO, tray, System Settings).
