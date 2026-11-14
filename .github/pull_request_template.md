<!-- Keep it short: this description becomes the commit message on main, so it
     fits on one screen (about 150 words).
     Describe the result, not the investigation, and do not tour the diff file by file.
     Delete a section that does not apply, and delete these comments. -->

## What and why

<!-- Two or three sentences: what changes for the user, and the problem it solves.
     Link issues with "Closes #123". User-visible? Add the line to CHANGELOG.md. -->

## How I verified it

<!-- One line per check, results only:
     - ctest (n/n) and `pre-commit run --all-files`
     - by hand in Plasma (Dolphin, tray, System Settings), or an e2e run on the test account
     - `./build-package.sh` for a packaging change
     Say what was NOT checked. Screenshots for a visual change. -->

## Risk

<!-- Only what applies, five bullets at most:
     - could it lose or trash user data (sync engine, deletions, conflicts)?
     - D-Bus contract, credentials or keyring, what the log file reveals
     - new runtime dependency, SDK or Proton CLI copy update
     - known limits and review findings left unfixed (not the ones fixed) -->
