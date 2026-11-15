<!--
SPDX-FileCopyrightText: 2026 Kation contributors
SPDX-License-Identifier: GPL-2.0-or-later
-->

# Plan: parallel transfers (`feat/parallel-transfers`, roadmap #7, 0.5.0)

## Context

The sync engine (`daemon/src/sync/engine.ts`) transfers one file at a time:
`reconcileFolder` walks a folder's items in order and awaits each upload or
download before the next item. With many small files the per-file round trips
dominate and sync is slow. Proton's Windows app runs 4 transfers at once, the
macOS app 8.

What already exists and must be reused, not rebuilt:

- The SDK queues itself: at most 5 file uploads (`MAX_CONCURRENT_FILE_UPLOADS`)
  and 5 downloads (`MAX_CONCURRENT_DOWNLOADS`) at once, in
  `daemon/node_modules/@protontech/drive-sdk/src/internal/{upload,download}/queue.ts`.
- The speed limits are shared by every transfer in a direction
  (`daemon/src/service/rateLimiter.ts`, owned by `DriveService`), so they
  already hold for the total.
- A full storage is already handled (0.4.0): Proton's `QuotaExceeded` sets
  `storageFull`, later uploads of the pass are not tried, reason
  `storageFull`, one Recent Activity entry, and `StorageMonitor.onSpaceFreed`
  resumes sync once free space grows.

## Decisions (made with the maintainer)

1. **4 transfers at once, fixed.** A constant `MAX_PARALLEL_TRANSFERS = 4` in
   the engine, uploads and downloads together. No setting, no D-Bus change.
2. **Tray text unchanged.** The status field `current` stays one path: the
   transfer started most recently. When it ends, `current` becomes another
   running transfer's path, or "" when none run. Only the D-Bus XML
   documentation of `current` changes ("one of the paths being transferred").
   No KDE code changes, no new strings.
3. **Reserve storage before each upload**, as Proton's Windows app does
   (`RemoteSpaceCheckingFileSystemClientDecorator`), so that parallel uploads
   do not overshoot the quota.

## Design

### Engine: a pass-wide transfer pool

Add a small pool class (in `daemon/src/sync/`, its own file with unit tests)
that runs at most N async jobs at once. `run(job)` waits for a free slot
(backpressure: the folder walk never races far ahead), then starts the job
and returns without awaiting it. The engine creates one pool per pass.

Unit of parallel work: **the file part of an item's reconciliation**, that
is the call `reconcileItem` makes to `reconcileFile`. Everything before it
stays inline and in order: move claims (`claimLocalMove`,
`followRemoteMoveTo/From`), type changes, folders and recursion into them.
So uploads, downloads, conflicts (`resolveConflict`: rename, upload, download,
in that order, inside one job) and file trashes run in the pool.

Invariants that keep today's reasoning valid:

- **A `reconcileFolder` call waits for the jobs it started before it returns.**
  Callers that act after it (`reconcileFolderItem`: record or remove a
  recreated folder; `syncFolderAt`: `removePending`, `reconciledThisPass`)
  then see the folder's files done, as today. Track jobs per call (a local
  list of promises), not only in the pool.
- **Drain before moving.** `applyLocalMove` and `moveLocal` (the only two
  places that move items or `moveTree` the base) first wait for every running
  job of the pass. A move can then never rename a folder under a running
  transfer or move a base entry a job is about to `recordFile`. Moves are
  rare, so this costs nothing in the usual case.
- **One job per path.** The walk visits each path once per folder, so two jobs
  never touch the same path. Keep it that way.
- **Per-item error handling is unchanged.** Move the `catch` body of the item
  loop in `reconcileFolder` into a method, and use it for errors thrown inline
  and by jobs: same retries (`notFoundRetried`), same `failedItems`,
  `storageFull`, `linkInTheWay`, activity entries and `errors` list.
- **Pass-aborting errors** (`SafetyPause`, `PASS_ABORTING_CODES`) from a job:
  start no new job, abort the running ones, wait for them, then rethrow the
  first such error from the folder's wait. Use an `AbortController` per pass
  chained to `this.abort` (stop and pause abort it too). Jobs that end with
  `Cancelled` because of that abort are not reported as failed items.
- **Stop and pause.** `stop()`, `setPaused(true)` and `checkRootPresence`
  already abort `this.abort`; the pass must still wait for every job to
  settle before it ends, so that no job writes the state database or the sync
  folder after the pass has returned.

Status and overlays:

- A set of paths being transferred replaces the single `status.current` for
  `itemState`: every running file shows `syncing` in Dolphin.
- `current` follows decision 2. `onItemsChanged` fires for a path when its
  transfer starts and ends.

Order of activity entries and log lines is no longer deterministic across a
folder. That is fine; nothing depends on it.

### Storage reservation (in `DriveService.uploadFile`)

In `DriveService`, so that it also covers uploads from Dolphin (KIO), which do
not go through the engine.

- `DriveService` gets a hook `freeSpace?: () => number | undefined` (wired in
  `serve.ts` from `StorageMonitor.get()`: `max - used`, undefined when unknown
  or unlimited).
- Before asking the SDK for an uploader, reserve the file's size (full size,
  also for a new revision of an existing file). It does not fit when
  `size > freeSpace - reserved`: throw `KationError('QuotaExceeded', …)`
  without contacting Proton, and call `hooks.onQuotaExceeded` as for Proton's
  refusal, so the existing storageFull handling, the tray notification and
  the resume on freed space all work unchanged.
- `reserved` = sizes of uploads in progress, plus sizes of uploads that
  finished after the last storage reading started (the reading does not count
  them yet). Release on failure or abort. `StorageMonitor` needs to say when
  its current reading started (or call back when a reading is applied) for
  the second part; a completed upload should also call `storage.changed()`
  so the reading is refreshed.
- Free space unknown (storage not read yet, signed out, unlimited account):
  no check, as today.
- A stale reading can refuse too early (space freed elsewhere): the next
  reading fires `onSpaceFreed` and sync resumes; or too late: Proton refuses,
  as today. Both are acceptable.

## Acceptance criteria

1. With the fake drive slowed down (`chunkDelayMs`), syncing 12 new local
   files runs exactly 4 uploads at once at its peak, never more; same for 12
   new remote files (downloads), and for a mix.
2. All existing `syncEngine`, `syncController` and `driveService` tests pass
   unchanged, except where a test asserted an order between items of one
   folder that is no longer guaranteed: compare as sets there, never weaken
   what a test checks otherwise.
3. One failing transfer does not stop the others; it is reported exactly as
   today (failedItems, error activity, reason, retry).
4. A pass-aborting error in one job aborts the running jobs, the pass ends
   with that error, and the cancelled files are not reported as failed.
5. Pause and stop during parallel transfers: no job writes the state or the
   sync folder afterwards; resuming syncs the interrupted files.
6. A remote rename of a folder, applied while files are transferring in a
   sibling folder, waits for those transfers, and both end up correct.
7. `itemState` returns `syncing` for each running file and its ancestors.
8. With a 100-byte quota (fake drive `maxStorage`) and four 30-byte files,
   3 are uploaded; the 4th is refused before any request reaches the fake
   drive, the pass reports `storageFull` with one activity entry, and sync
   resumes when space is freed.
9. A KIO upload (`DriveService.upload`) that does not fit is refused the same
   way; a reservation is released when an upload fails or is aborted.
10. The new pool has its own unit tests (limit, backpressure, error and abort
    behaviour).
11. `bun test`, `bun x tsc --noEmit -p .` and Biome
    (`./node_modules/.bin/biome check`) pass in `daemon/`.

## Also in this change

- `dbus/com.hleroy.Kation.Drive1.xml`: document `current` as one of the paths
  being transferred. No other contract change.
- `docs/sync.md` (and DEVNOTES.md if it describes the transfer order):
  transfers run 4 at a time; the two invariants above.
- `daemon/e2e/realAccount.ts` and `docs/e2e-test-plan.md` Part A: add
  **E2E-26** (20 small files created locally are all uploaded, with uploads
  overlapping in the log, at most 4 at once) and **E2E-27** (20 files created
  on Proton are all downloaded, same check). Write them; do **not** run them:
  the maintainer runs the e2e plan locally after the cloud work.
- `CHANGELOG.md` `[Unreleased]`: one line under Changed, e.g. "Sync transfers
  up to 4 files at once, so folders of many small files sync much faster;
  uploads that would not fit in the remaining storage are not started."
- `ROADMAP.md`, as PR #31 did for the storage quota: add a short
  "**Parallel transfers (0.5.0)**" entry to the features section, remove row 7
  from the table and renumber the rows after it (keep the table pipe-aligned),
  and replace the "Next: parallel transfers (#7) for 0.5.0." line.

## Out of scope

- A user setting for the number of transfers; changing tray texts.
- Parallel transfers within KIO (each KIO worker already runs on its own).
- Anything in `daemon/src/proton/` or `third_party/` (never edited).

## Working in a cloud session

The cloud VM (Ubuntu 24.04) has no Qt 6 / KF6, so the CMake build and the full
ctest suite cannot run there. This change is daemon-only, so:

- First, once: `git submodule update --init`, then
  `cd daemon && bun install --frozen-lockfile` (Bun 1.4.4, see
  `daemon/.bun-version`).
- Instead of the full ctest suite, run before every commit, in `daemon/`:
  `bun test`, `bun x tsc --noEmit -p .`, `bun ./scripts/protonCopy.ts check`,
  and `./node_modules/.bin/biome check`. Run `pre-commit run --all-files` too
  if it is installed. The maintainer runs the full ctest suite and the e2e plan
  locally before merging.
- The `code-review` skill named in CLAUDE.md is not available in the cloud:
  review the diff in a fresh-context subagent with these acceptance criteria
  and CLAUDE.md, same rules (fix high and critical, at most two passes).
- Commit on `feat/parallel-transfers`, push, and open the PR (Conventional
  Commits title, e.g. `feat(daemon): transfer up to 4 files at once`; body from
  `.github/pull_request_template.md`). Do not merge it.
