# Code from the Proton Drive CLI

These modules come from the Proton Drive CLI (`cli/src` in
[ProtonDriveApps/sdk](https://github.com/ProtonDriveApps/sdk)), MIT licensed,
copyright Proton AG. They wire the Drive SDK to the account module: session
storage, encrypted caches, event cursors, HTTP hooks and the log file.

Upstream: tag `cli/v0.9.0` (commit `df3a717b`), the same commit as the
`third_party/proton-drive-sdk` submodule.

**Do not edit these files.** This folder is exactly:

- the files of the submodule's `cli/src`,
- minus the paths listed in `NOT_COPIED` in `daemon/scripts/protonCopy.ts`
  (each with its reason),
- plus the two changes in `kation.patch`.

ctest's `proton-copy` (`bun scripts/protonCopy.ts check`, run from `daemon/`)
fails on any other difference. Only this README and `kation.patch` are Kation's
own files here.

## The two changes

Both are in `kation.patch`, and each is marked with a `// Kation:` comment.

- `credentials/constants.ts`: `CREDENTIALS_SERVICE` is Kation's app ID instead
  of `ch.proton.drive/drive-sdk-cli`. With the CLI's name, Kation and the
  official CLI would overwrite each other's stored session. The hunk also
  imports `APP_ID` from `src/appInfo.ts`, the copy's only use of Kation's code.
- `telemetry/fileHandler.ts`: `LOG_FILE_NAME` is `kationd.log` instead of
  `proton-drive.log`. Kation is not an official Proton client.

Neither can be done from outside: the keyring and `pass` stores import
`./constants` directly, and `FileLogHandler` opens the file in its constructor.

## When Kation needs something different

Change Kation's code, not the copy:

- **Wrap or build it yourself.** `src/keyring.ts` picks the session store and
  wraps it in `ReportingStore`, repeating the `switch` of
  `createAuthSessionStore` (`credentials/index.ts`), which offers no way to wrap
  the store. `initCredentials` is therefore unused.
- **Extend the type.** Kation's `Config` (`src/config.ts`) extends the one in
  `config.ts`. The CLI's `getConfig`, with its `PROTON_DRIVE_*` variables and
  `proton-drive-cli` folders, is unused.
- **Import the file directly, and leave out what Kation replaces.** Kation polls
  for events itself (`src/events.ts`), so `events/manager.ts` and
  `events/index.ts` are not copied; the providers are imported from their own
  files.

A third change to the copy needs a strong reason. If there is one, make it,
mark it with `// Kation:`, add the file to `PATCHED_FILES` in the script (the
patch may change no other file), run `bun scripts/protonCopy.ts make-patch`
and describe it above.

## Moving to a newer CLI release

Run the commands from `daemon/`.

1. Move the submodule to the new tag and reinstall, since Bun keeps its own
   copy of the SDK in `node_modules`:

   ```sh
   git -C ../third_party/proton-drive-sdk fetch --tags
   git -C ../third_party/proton-drive-sdk checkout cli/vX.Y.Z
   bun install
   ```

2. Rebuild the copy: `bun scripts/protonCopy.ts update`. It prints each file
   it adds, updates or removes.
3. If it stops, do what the message asks:
   - **`kation.patch` does not apply:** upstream changed the lines around a
     constant. Copy that file from the submodule, change the constant by hand
     (keep the `// Kation:` comment), then run
     `bun scripts/protonCopy.ts make-patch` and `update` again. `make-patch`
     reads only the two patched files, so the rest of the copy, still on the
     old release at this point, does not end up in the patch.
   - **`NOT_COPIED` lists a path upstream no longer has:** remove the entry.
4. Look at each file that `update` added. Keep it if the copied modules import
   it. Otherwise add it to `NOT_COPIED` with a reason and run `update` again,
   which removes it. Never copy the telemetry upload (Sentry, metrics). A kept
   file that imports a module that is not copied shows up as an error in the
   next step.
5. Run `bun x tsc --noEmit -p .`. Errors in Kation's code show what upstream
   changed, such as a new `Config` field or a constructor argument. Fix them in
   Kation's files.
6. Compare what Kation repeats or replaces, since the compiler does not check
   those:
   - `createAuthSessionStore` in `credentials/index.ts` against `innerStore` in
     `src/keyring.ts`.
   - `events/manager.ts` in the submodule against `src/events.ts`.
   - `init.ts` in the submodule against `src/drive.ts` (feature flags, the
     SDK's dependencies).
7. Read `cli/CHANGELOG.md` in the submodule for behaviour changes.
8. Update the tag and commit at the top of this file.
9. Run the full ctest suite. `proton-copy` must pass.
