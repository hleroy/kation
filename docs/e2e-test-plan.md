<!--
SPDX-FileCopyrightText: 2026 Kation contributors
SPDX-License-Identifier: GPL-2.0-or-later
-->

# End-to-end test plan (real Proton test account)

This plan is written for a **Claude Code session running on the tester's
desktop**, working together with the tester. Claude Code runs everything
that can run from a terminal; the tester does what needs eyes, a browser or
a desktop logout.

It covers the initial release (sign-in, the online view, folder sync,
Plasma integration). The automated part takes about 15–30 minutes, mostly waiting
for Proton's change notifications.

## Rules for Claude Code

1. **Test account only.** Before anything else, ask the tester for the email
   of the Proton *test* account. The runner refuses to run if another
   account is signed in; never work around that check.
2. **Stay inside the test folder.** The runner works only in
   `/KationE2E-<timestamp>` (in "My files" and in the local sync folder).
   Do not create, change or delete anything else in `~/Proton Drive` or in
   Proton Drive. The one exception is test E2E-12, which renames the sync
   folder and puts it back; if a run is interrupted during E2E-12, rename
   `~/Proton Drive.e2e-renamed` back to `~/Proton Drive` first.
3. **Observe, do not fix.** Do not edit the source, commit, push or open
   pull requests. When something fails, collect evidence (see "When a test
   fails") and describe it. The tester decides what happens next.
4. **Ask before anything the tester must do**, and wait for their answer.
   Steps marked **TESTER** below need them.
5. **No sign-out** unless a step says so.
6. Never print or copy the contents of the keyring, `~/.local/share/kation`
   or session tokens into the report.

## Prerequisites (check, do not assume)

Run these and confirm each one before Part A. If something is missing, tell
the tester what to do and wait.

| Check | Command | Expected |
|---|---|---|
| Up to date | `git -C <repo> log --oneline -1` | latest commit of the branch |
| Built and tested | `cmake --build build && ctest --test-dir build --output-on-failure` | all tests pass |
| Installed | `sudo cmake --install build` (**TESTER**: needs their password), then `pkill -x kationd` | `which kationd` → `/usr/bin/kationd` |
| Service running | `kationd status` | `Signed in as <test account>` |
| Sync on | `kationd sync` | `Sync idle: /home/<user>/Proton Drive` |

If `kationd status` says "Not signed in": **TESTER** opens the Kation
window and clicks **Sign In…**. If sync is off: **TESTER** clicks **Turn On
Sync** (or pass `--enable-sync` to the runner, after asking).

## Part A: automated tests

From the repository:

```sh
cd daemon
bun install                  # once
bun e2e/realAccount.ts --expect-email <test account email>
```

Options: `--only E2E-03,E2E-05` (run some tests), `--skip E2E-15`,
`--big-mb 300` (size of the file used by E2E-14; increase it on a very fast
connection), `--remote-timeout 300` (seconds to wait for Proton's change
notifications; default 180), `--keep` (keep the test folder for
inspection).

The runner prints each test as it goes and writes `build/e2e-report.md`.
Exit code 0 means everything passed.

| ID | What it checks |
|---|---|
| E2E-01 | `kationd status` and `kationd sync` answer through the running service |
| E2E-02 | A new local folder and file reach Proton |
| E2E-03 | A file created on Proton appears locally (Drive change notifications) |
| E2E-04 | A local edit becomes a new version on Proton |
| E2E-05 | An edit on Proton updates the local file |
| E2E-06 | A local deletion removes the file on Proton (it goes to the Proton trash) |
| E2E-07 | A deletion on Proton moves the local file to the desktop Trash |
| E2E-08 | Pause holds local changes; resume sends them |
| E2E-09 | A file edited on both sides while paused keeps both versions (conflict copy) |
| E2E-10 | A folder deleted on Proton keeps the files changed locally meanwhile |
| E2E-11 | A folder deleted locally is trashed on Proton |
| E2E-12 | Renaming the sync folder pauses sync within seconds, nothing is deleted, and sync resumes by itself when it is back |
| E2E-13 | An excluded folder stops syncing, its local copy can be deleted safely, and it comes back when included |
| E2E-14 | An interrupted download continues instead of restarting (and passes the checksum) |
| E2E-15 | Deleting more than 100 files at once pauses sync until resumed |
| E2E-16 | Online view operations (create, upload, stat, rename, download); `kioclient` too if installed |
| E2E-17 | `kationd.service` is enabled (starts with the session) and active |
| E2E-18 | No errors in the log during the run (expected situations, such as a transfer stopped by a pause or a remote change racing an upload, are logged below ERROR). Runs last |
| E2E-19 | Recent activity (tray menu) lists an upload with its local path |
| E2E-20 | Sync states for Dolphin's emblems: synced, paused while paused, nothing outside the folder |
| E2E-21 | Public link of a test file: none at first, created on request, the same when asked with the local path; web app address. The link stops working when the test folder is trashed |
| E2E-22 | A 512 KiB/s download limit slows a 2 MiB download to about 4 s; the previous limits are restored |

Notes for reading results:

- E2E-15 deletes up to 100 files before it pauses: the safety stop limits
  damage, it does not prevent the first 100 deletions. The report says how
  many went before the pause.
- E2E-14 is skipped (not failed) when the download finishes before it can be
  paused: run it again with a larger `--big-mb`.
- Remote-to-local tests depend on Proton's change notifications, which
  arrive every 30 seconds or so. Timeouts are generous; a timeout is still a
  failure worth reporting.

## Part B: tester steps

Do these after Part A, in order. For each, tell the tester exactly what to
do, wait for their answer, then run the verification and record the result.

### M1. Kation window and tray icon (TESTER)

Ask the tester to open **Kation** from the launcher and describe or
screenshot it. Expected:

- A window with three tabs: **General**, **Folders to Sync**, **Network and
  Startup**. General shows "Signed in" with the test account email, a
  Folder Sync section saying "Up to date. Last synced …", the italic
  third-party notice, and **Open Synced Folder**. Nothing is cut off.
- A Kation icon (a K beside a cloud, with a green check-mark badge) in the
  system tray.
  Closing the window leaves the icon; launching Kation again opens the
  window of the same instance (no second icon).

Verify: `ls ~/.config/autostart/com.hleroy.Kation.tray.desktop` exists.

### M2. Online view in Dolphin (TESTER)

Ask the tester to:

1. Open Dolphin → Network → **Proton Drive (online)**: their files are
   listed.
2. Open a PDF or image from there: it opens.
3. Drag a small file from their computer into a folder there, and drag one
   out.

Verify the dragged-in file with `kationd ls /<folder>`.

### M3. Proton trash (TESTER)

Ask the tester to open the Proton Drive web app → Trash: the `hello.txt`
from E2E-06 and the `Old` folder from E2E-11 are there (or the whole
`KationE2E-…` folder, which the runner trashes when it finishes).

### M4. Session ended by Proton (TESTER)

1. Note the time. Ask the tester to revoke the Kation session in the web
   app (Settings → Security → Session management).
2. Within about a minute, `kationd status` should print "Not signed in." and
   the "session ended" message; ask the tester to confirm the Kation window
   says so too.
   Ask also whether a notification "Signed out of Proton Drive" appeared,
   and whether the tray icon changed (grey "×" badge).
3. Ask the tester to sign in again in the window. Then
   `grep "Sync pass" ~/.local/state/kation/kationd.log | tail -1` should end
   with `full (local)` (sync resumed, no full re-listing).

### M5. System Settings (TESTER)

Ask the tester to open System Settings → Network → **Proton Drive
(Kation)** (or run `kcmshell6 kcm_kation`). Expected: the same three tabs
as the Kation window.

1. **Folders to Sync**: the folders of "My files" are listed, all checked
   (unless some were excluded before); expanding one shows its subfolders.
   Ask the tester to uncheck a small folder and click **Apply**. Verify with
   `kationd sync excluded`. Then ask them to check it again and **Apply**;
   `kationd sync excluded` no longer lists it.
2. **Network and Startup**: ask the tester to set an upload limit of
   500 KiB/s and **Apply**. Verify with `kationd sync limits` ("upload 500
   KiB/s"). Ask them to untick it and **Apply**; verify "no limit".

### M6. Dolphin emblems and context menu (TESTER)

Before asking, create `~/Proton Drive/KationE2E-M6/` with a small file
`shared.txt`, and wait until `kationd ls /KationE2E-M6` lists it.

1. Ask the tester to open `~/Proton Drive` in Dolphin: files and folders
   carry a small check-mark emblem. (Dolphin loads plugins when it starts:
   if there are no emblems, quit Dolphin completely and open it again.)
2. Run `kationd sync pause`, then create
   `~/Proton Drive/KationE2E-M6/waiting.txt`. Ask the tester: the new file
   has a pause emblem. Run `kationd sync resume`: it turns into a check
   mark within seconds.
3. Ask the tester to right-click `shared.txt` → **Proton Drive** → **Copy
   Public Link**. Kation asks before creating the link; after confirming,
   a notification says the link was copied. Verify:
   `kationd link "/KationE2E-M6/shared.txt"` prints the same link the
   tester pastes from the clipboard. (No **Proton Drive** submenu? Dolphin →
   Configure Dolphin → Context Menu: tick "Proton Drive links (Kation)".)
4. Ask the tester to right-click it → **Proton Drive** → **Open in Proton
   Drive Website**: the browser opens the file in the web app.
5. The same submenu appears on items in **Proton Drive (online)**.

Clean up: trash the folder with
`gdbus call --session -d com.hleroy.Kation -o /com/hleroy/Kation -m com.hleroy.Kation.Drive1.Trash /KationE2E-M6`
(this also ends the public link).

### M7. Tray menu and notifications (TESTER)

1. Ask the tester to open the tray icon's menu. Expected: a status line
   ("Up to date"), **Open Synced Folder**, **Open Online View**, **Pause
   Sync**, **Sync Now**, **Recent Activity** (listing recent uploads and
   downloads, e.g. from M6), **Settings…**, **Quit**.
2. Ask them to click **Pause Sync**: the icon shows a grey pause badge and
   `kationd sync` says paused. **Resume Sync**: back to the green check mark.
3. Conflict notification. Create the file on both sides first, then
   change it on each side while paused:

   ```sh
   echo base > ~/Proton\ Drive/KationE2E-M7.txt
   # wait until it is listed:
   kationd ls / | grep KationE2E-M7.txt
   kationd sync pause
   echo local > ~/Proton\ Drive/KationE2E-M7.txt
   echo remote > /tmp/m7.txt
   gdbus call --session -d com.hleroy.Kation -o /com/hleroy/Kation \
     -m com.hleroy.Kation.Drive1.Upload /tmp/m7.txt /KationE2E-M7.txt true m7
   kationd sync resume
   ```

   Ask the tester: a notification "Kept both versions" appears within a few
   seconds, and its **Show in Folder** button opens Dolphin on the conflict
   copy. **Recent Activity** lists "Kept both versions of KationE2E-M7.txt".
4. Clean up: delete `~/Proton Drive/KationE2E-M7*.txt` locally (they go to
   the Proton trash).

### M8. Start with the session, stop at logout (TESTER)

This one ends the desktop session, and Claude Code with it. Before asking
the tester to log out:

1. Write the current results to `build/e2e-report.md` (Part A plus M1–M7).
2. Tell the tester: close the Kation window (keep the tray icon), log out
   (Application Launcher → Leave → Log Out), wait 30 seconds, log back in
   **without opening Kation**, start Claude Code in the repository again
   and say: *"Continue the Kation end-to-end plan at M8 verification."*

M8 verification (in the new session):

```sh
systemctl --user is-active kationd.service      # active
grep "Sync pass" ~/.local/state/kation/kationd.log | tail -1   # full (local)
journalctl --user -u kationd.service --since "15 min ago" | grep -E "Stopping|Stopped|Started" | tail -5
pgrep -a kation                                  # kationd, and "kation --tray"
```

The journal should show kationd stopping at logout and starting at login.
Ask the tester: the tray icon is back, and the Kation **window** did not
open by itself. Then create `~/Proton Drive/KationE2E-M8.txt`, check it
appears with `kationd ls /`, and delete it again (local delete; it goes to
the Proton trash).

## When a test fails

Collect, without changing anything:

```sh
grep -E "SetSync|Sync pass|Sync paused|Sync resumed|Uploading|Downloading|Resuming|Start at login|session|ERROR|WARNING" \
  ~/.local/state/kation/kationd.log | grep -v '^{' | tail -60
kationd sync --json
kationd status --json
```

Rerun just that test once with `--only <ID> --keep` to see whether it is
reproducible, and look at the kept test folder on both sides
(`ls -la ~/Proton\ Drive/KationE2E-*`, `kationd ls /KationE2E-…`). Put the
evidence in the report. Then trash the kept folder with
`gdbus call --session -d com.hleroy.Kation -o /com/hleroy/Kation -m com.hleroy.Kation.Drive1.Trash /KationE2E-…`.

## Report

`build/e2e-report.md` is written by the runner. Append:

- the prerequisite checks and their output summary;
- one line per manual step (M1–M8): PASS/FAIL and what was observed;
- for each failure: what was expected, what happened, the evidence, whether
  it reproduced.

End with a short summary for the tester: what passed, what failed, what to
send to the developer (the report file).
