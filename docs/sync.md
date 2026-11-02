<!--
SPDX-FileCopyrightText: 2026 Kation contributors
SPDX-License-Identifier: GPL-2.0-or-later
-->

# How folder sync works

Folder sync keeps a folder on your computer (`~/Proton Drive` unless you
choose another) and "My files" in Proton Drive identical, in both
directions. It is off until you turn it on in the Kation window.

## What gets copied

- New files, edits, new folders and deletions are copied to the other side.
  Changes on your computer are picked up within seconds; changes made
  elsewhere (the website, your phone) arrive through Proton Drive's change
  notifications.
- The synced folder is a full local copy: it works offline, and pausing sync
  affects only this folder. Browsing `protondrive:/` in Dolphin always shows
  Proton Drive as it is online, whether sync is paused or not.
- Temporary files (`*.part`, `.~lock.*`, `*~`, …) and Proton Docs and Sheets,
  which exist only online, are not synced.
- Renaming or moving a file is synced as a new file plus a deletion, so the
  file is transferred again.

## Deletions and conflicts

- **Nothing is deleted outright.** A file deleted on your computer goes to
  the Proton Drive trash; a file deleted in Proton Drive goes to your desktop
  Trash.
- **Conflicts keep both versions.** If a file changed on both sides, the
  Proton Drive version keeps the name and yours is renamed
  `name (conflict 2026-11-01 1042).ext` and uploaded too. Kation notifies
  you.
- If a folder is deleted on one side while you changed files inside it on
  the other, your changed files are kept.

## When sync pauses by itself

Sync pauses instead of deleting when something looks wrong, and tells you
why:

- **The sync folder disappears or is replaced**, for example on an unplugged
  disk. Sync resumes by itself when the folder is back.
- **You sign in to a different account.**
- **More than 100 items would be deleted at once.** Check what happened, then
  resume sync to confirm.

If Proton ends the session (it expired, or you signed out from another
device), sync stops and the Kation window asks you to sign in again; sync
then resumes where it stopped.

## Choosing what to sync

- **Folders to Sync:** untick folders in the Kation window (or run
  `kationd sync exclude /Videos`). Their files already on your computer
  stay, and you can delete them to free space without affecting Proton
  Drive.
- **Speed limits** for uploads and downloads, in the Kation window (or
  `kationd sync limits 500 0` for 500 KiB/s up and no download limit). The
  limits are averages, so short bursts can go faster.

The first sync downloads everything you selected, so check your free disk
space, or untick big folders first.

## Running in the background

- While sync is on, Kation's background service starts when you log in and
  stops when you log out. Closing the Kation window or quitting the tray
  icon does not stop sync.
- Interrupted downloads continue where they stopped (the result is checked
  against Proton's checksum). Interrupted uploads start again from the
  beginning.
