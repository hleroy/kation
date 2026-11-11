<!--
SPDX-FileCopyrightText: 2026 Kation contributors
SPDX-License-Identifier: GPL-2.0-or-later
-->

# Feature gap analysis (November 2026)

What Kation 0.3.0 lacks compared with Proton's official desktop apps and with
what users ask for on Proton's UserVoice, ranked with MoSCoW.

## Method

1. **Baseline.** Kation 0.3.0 as described in [ROADMAP.md](../ROADMAP.md)
   and the D-Bus contract.
2. **Official clients.** Feature inventory taken from the source of
   [windows-drive](https://github.com/ProtonDriveApps/windows-drive) (views,
   `Strings.resx`, `sync/cs`) and
   [mac-drive](https://github.com/ProtonDriveApps/mac-drive) (Finder actions in
   the File Provider `Info.plist`, `Mac-Localizable.xcstrings`), plus Proton's
   [support pages](https://proton.me/support/drive/desktop-drive/windows-drive)
   and [Drive roadmap](https://proton.me/drive/roadmap).
3. **User voice.** The first four "Top" pages (80 ideas) of the
   [Proton Drive UserVoice](https://protonmail.uservoice.com/forums/932839-proton-drive/filters/top),
   votes as of 2026-11-11. Ideas that only concern the web, mobile apps, Docs
   or Sheets editing, or pricing are grouped under "Won't".
4. **Ranking.**
   - **Must:** a gap in reliable file sync, or a feature both official
     desktop apps (or Windows plus a top-voted idea) have that users expect
     from any Proton Drive desktop client.
   - **Should:** high value (official parity or more than about 500 votes),
     feasible with the SDK Kation uses.
   - **Could:** useful, lower demand or higher cost.
   - **Won't (now):** outside a desktop client's scope, a server-side or
     web/mobile feature, or deliberately out of scope (ROADMAP.md).

Columns W, M and U say whether the Windows app, the macOS app and UserVoice
cover or ask for the feature (✓ has it, ◐ partly, — no, ? not confirmed in
the source, number = votes).

## Ranked list

| # | Feature | Priority | W | M | U | Description and references |
|---|---|---|---|---|---|---|
| 1 | Rename and move detection | **Must** | ✓ | ✓ | — | A local rename or move is uploaded again as a new file: it loses its version history and public link, and costs a full transfer. The Windows sync engine tracks file identity ([sync/cs](https://github.com/ProtonDriveApps/windows-drive/tree/main/sync/cs)); already on Kation's roadmap. |
| 2 | Follow the SDK and the new encryption scheme | **Must** | ✓ | ✓ | — | Proton rebuilt its SDK and encryption scheme in June 2026 and warns older SDK versions will break ([Drive roadmap](https://proton.me/drive/roadmap)). Kation pins `cli/v0.9.0`; upgrading on time keeps sync working. |
| 3 | "Shared with me": browse and sync | **Must** | ✓ | ◐ | 926 | Windows lists items shared with you, syncs them and makes them available offline ([support](https://proton.me/support/shared-with-me-windows), [blog](https://proton.me/blog/proton-drive-desktop-app)). Top desktop request: [Add Shared Folders to Proton Drive Sync](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/48819620-add-shared-folders-to-proton-drive-sync); also [Show Shared Folders in Finder](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/48729248-show-shared-folders-in-mac-os-finder) (147). |
| 4 | Sync any local folder ("My computer" / Computers) | **Must** | ✓ | ◐ | 436 + 419 | Windows backs up any folder (Documents, an external disk…) under a named device in the Computers section ([support](https://proton.me/support/proton-drive-windows-sync-folder)); planned for macOS as "by far the biggest missing feature" ([autumn/winter roadmap](https://proton.me/blog/2026-autumn-winter-roadmaps)). Ideas: [Sync existing macOS folders](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/47517635-sync-existing-macos-folders) (Planned), [Sync directories android/linux/windows](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/50245206-sync-directories-android-linux-windows-drive-and-a), [Enable syncing with external drives](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/50712002-enable-syncing-with-external-drives). Kation syncs one folder with "My files" only. |
| 5 | Storage quota display and over-quota handling | **Must** | ✓ | ✓ | — | Both apps show used/total space, warn near the limit and say "Sync stopped: your account has exceeded the storage capacity" (`Main_Account_Storage_*` in Windows, "Out of storage" in macOS). Kation shows neither; an over-quota upload would surface as a generic error. Needs a new `problemCode`. |
| 6 | Photos: import a local folder and Google Takeout | **Should** | ✓ | — | 1 668 / 939 | Windows imports folders into Photos and albums, skipping duplicates, and imports Google Takeout exports (`Photos/Import`, [Drive roadmap](https://proton.me/drive/roadmap)). Ideas: [Sync Photos folder with desktop app](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/47568116-sync-photos-folder-with-desktop-app), [Photos bidirectional sync](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/50091789-photos-bidirectional-sync), [Google Takeout Import Tool](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/50108208-google-takeout-import-tool-for-proton-drive) (103). |
| 7 | Exclusion patterns (ignore file) | **Should** | — | — | 774 | Neither official app has user-defined patterns; Kation has folder-level selective sync and built-in temporary-file rules. [Exclude folders/files](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/46975450-exclude-folders-files) asks for `.gitignore`-style rules (`node_modules`, build output). A cheap edge over the official apps. |
| 8 | Detailed sync progress | **Should** | ✓ | ✓ | 691 | Both apps show a transfer list with per-file progress (Windows Activity view, macOS GlobalProgress). Kation's status gives the current path and the number of pending folders only. [Show sync progress](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/46935400-show-sync-progress). |
| 9 | Parallel transfers | **Should** | ? | ? | — | Proton's rebuilt engine made official uploads up to 3x and downloads up to 2x faster ([Drive roadmap](https://proton.me/drive/roadmap)). Kation transfers one file at a time, which is slow for many small files; on its roadmap. |
| 10 | Thumbnails on upload | **Should** | ✓ | ? | — | Windows generates thumbnails before upload (`Thumbnails/Win32ThumbnailGenerator`); files Kation uploads show no preview on the web and mobile apps. Can use KIO thumbnailers. On Kation's roadmap. |
| 11 | Package repositories (updates) | **Should** | ✓ | ✓ | 2 130 | Official apps update themselves ("Update now", update required); Kation users download each release by hand. AUR, COPR and an APT repository give the same through the system updater. Linux demand: [Drive Linux](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/51117355-drive-linux), the 3rd most voted idea. |
| 12 | Full resync / repair | **Should** | — | ✓ | — | macOS offers "Resync" (resume, cancel, or rebuild the sync folder) for when files look out of sync (`FullResync`). Kation has no supported way to rebuild its state database short of signing out. |
| 13 | Proton Docs and Sheets in the sync folder | **Could** | ✓ | ✓ | — | Windows places Docs and Sheets in the folder as shortcuts that open in the browser (`Docs/DocumentOpener`); Kation skips them, so they look missing locally. A `.desktop`-style link file or a KIO entry that opens the web editor would do. |
| 14 | Timed pause | **Could** | ✓ | — | — | Windows 3.0.2 pauses for a few hours or until the next day and resumes on its own ([Drive roadmap](https://proton.me/drive/roadmap), 2 July 2026). Kation pauses until resumed. |
| 15 | Manage public links and share with people | **Could** | — | ◐ | 363 | macOS client code covers share URLs and members (`PDClient/CollaborativeSharing`); Windows leaves sharing to the web. Kation creates view-only links; password, expiry, removal and invitations by email are on its roadmap. Related: [email alias for shared downloads](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/50128554-allow-selection-of-email-alias-for-proton-drive-sh). |
| 16 | Search (KRunner, Dolphin) | **Could** | — | — | 229 + 120 | No desktop app searches Drive; Proton extends search on web and mobile ([autumn/winter roadmap](https://proton.me/blog/2026-autumn-winter-roadmaps)). [In-Content Search](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/47426186-in-content-seach), [Search within files](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/50855192-drive-search-within-files). Name search via KRunner is on Kation's roadmap. |
| 17 | Folder size and statistics | **Could** | — | — | 564 | [Folder info (size, stats)](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/45658396-folder-info-size-stats). `protondrive:/` could report folder sizes and item counts in Dolphin's Properties dialog. |
| 18 | Trash and version history | **Could** | — | — | 114 | Neither desktop app has them (web only). [File versioning / prompt before overwrite](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/41910757-file-versioning-prompt-with-options-before-file). On Kation's roadmap; would make Kation ahead of the official apps. |
| 19 | Access from non-KDE apps and scripts (FUSE, WebDAV, rsync) | **Could** | — | — | 1 021 / 704 / 409 / 264 | `protondrive:/` reaches KDE apps only. [Proton Drive API](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/43582125-proton-drive-api), [ProtonDrive Bridge](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/42237280-protondrive-bridge), [WebDAV Access (Linux)](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/50244357-webdav-access-for-protondrive-linux), [Rsync compatibility](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/50517573-rsync-compatibility). `kationd` commands cover part of it; Proton's own [Drive CLI](https://proton.me/drive/roadmap) covers more. |
| 20 | Multiple accounts | **Could** | — | — | — | Neither official app supports it. On Kation's roadmap. |
| 21 | Bug report from the app | **Could** | ✓ | ✓ | — | Both apps send a report with logs (`Views/BugReport`, macOS `Reporting`). For Kation: a "Report a problem" action that collects the log and opens a prefilled GitHub issue. |
| 22 | On-demand files (placeholders, "Free up space") | **Won't (now)** | ✓ | ✓ | 364 | The heart of both official apps: Windows Cloud Files ([on-demand sync](https://proton.me/support/proton-drive-windows-on-demand-sync)), macOS File Provider ("Make Available Offline", "Online Only (Free Up Space)"). Linux has no system API for it, so it would take a FUSE file system; out of scope in ROADMAP.md, with `protondrive:/` and selective sync as substitutes. Revisit if users ask. [Selective syncing of files](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/45727027-selective-syncing-of-files-for-mac-linux-windows). |
| 23 | Photo library features (albums, shared library, search, organize, dedupe) | **Won't (now)** | ◐ | — | 2 970, 1 499, 1 275, 880, 791 | Browsing and organizing photos belongs to the web and mobile apps: [Proton Photos](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/45569155-proton-photos), [Shared photo library](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/49920087-shared-photo-library), [searchable photos](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/49764116-make-photos-searchable-in-photos-section), [Organize Photos](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/50198985-organize-photos), [Remove duplicate photos](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/48072713-remove-duplicate-photos). Import (row 6) is the desktop part. |
| 24 | Docs, Sheets and Slides editing | **Won't (now)** | — | — | 2 740, 1 410, 1 215, 932 | Web editors: [Proton Slides](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/49779578-proton-slides), [Docs dark mode](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/48610019-proton-docs-dark-mode-dark-theme-please), [Docs .odt import/export](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/48607370-proton-docs-import-export-odt), [Offline editing of Documents](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/48610982-offline-editing-support-for-documents-in-proton-dr). |
| 25 | Vault with an extra password | **Won't (now)** | — | — | 1 129 | Needs server and key-model support: [Vault](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/47787002-it-would-be-nice-if-the-proton-drive-included-a-va). |
| 26 | Synology NAS, Android storage, storage plans | **Won't** | — | — | 1 342, 1 881, 1 470 | Other platforms or pricing: [Synology NAS Cloud Sync](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/48439454-synology-nas-cloud-sync), [Android default storage](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/46393474-proton-drive-integration-with-android-default-stor), [More storage options](https://protonmail.uservoice.com/forums/932839-proton-drive/suggestions/42228748-more-storage-options). |

## Where Kation is already ahead

Upload and download speed limits, folder-level selective sync, Dolphin and
Open/Save dialog access without syncing (`protondrive:/`), safety pauses
(mass deletion, missing or unmounted folder, another account) and a
scriptable `kationd` CLI. The official apps offer none of the speed limits
or safety pauses.

## Context

Proton plans an official Linux beta, "likely" a headless sync daemon only
([autumn/winter 2026 roadmap](https://proton.me/blog/2026-autumn-winter-roadmaps)).
Kation's distinct value would then be the Plasma integration (Dolphin,
KIO, tray, System Settings), which argues for rows 3 to 8 over features a
headless daemon would also provide.
