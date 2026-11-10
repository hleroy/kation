<!--
SPDX-FileCopyrightText: 2026 Kation contributors
SPDX-License-Identifier: GPL-2.0-or-later
-->

# Security review, November 2026

Review of Kation at commit `8951bca` (0.2.0 plus the symbolic-link fix), covering
`kationd`, the code copied from the Proton CLI, the KDE components, packaging
and CI, and how Kation uses the pinned Proton SDK (`df3a717`).

## Result

| ID | Severity | Finding | Status |
|---|---|---|---|
| H1 | High | `kationd` loads `bunfig.toml` and `.env` from the folder it is started in | Fixed |
| H2 | High | `kationd` loads modules from `node_modules` of the folder it is started in | Fixed |
| M1 | Medium | The online view opens a file with the application its uploader chose | Open, decision needed |
| L1 to L14 | Low | See [Low](#low) | Open |

No critical finding. Findings that only matter to a program already running as
the user (the trust rule in [DEVNOTES.md](../DEVNOTES.md)) are not listed.

## How it was done

- Every source file of `kationd` and of the KDE components was read, with the
  SDK's sign-in, token refresh and download code.
- `kationd` was built and run against its fake drive on a private session bus:
  every D-Bus method was called with hostile arguments, and the sync engine was
  fed hostile remote names.
- `bun audit` was run, and the packages bundled into the executable were listed
  from its source map.

Limits: the KDE components could not be built in the review environment (no
Qt 6 or KF6 packages), so findings in `kde/` come from reading the code, and
KIO's behaviour from reading its source. Nothing was tested against a real
Proton account.

Attackers considered: someone who can put files in the user's drive (an editor
of a shared folder), Proton's servers and the network, another user of the
machine, the supply chain, and someone holding the disk.

## High

### H1. kationd loads bunfig.toml and .env from the folder it is started in

Programs compiled with `bun build --compile` load `bunfig.toml` and `.env` from
the current folder unless the build turns that off, and
`daemon/scripts/build.ts` did not. `bunfig.toml` can name scripts to run first
(`preload`).

- Any `kationd` command run in a folder holding a `bunfig.toml` ran the script
  it named. The README suggests `kationd link` with a local path, so people run
  it inside the synced folder, where an editor of a shared folder can place
  both files.
- The service starts in the home folder (systemd's default for user units), so
  a `~/.env` changed its settings: for example `NODE_TLS_REJECT_UNAUTHORIZED=0`
  turns off certificate checks.

Reproduced: a planted `bunfig.toml` ran its script on `kationd version`, and a
planted `.env` set `KATION_CREDENTIALS_STORE`.

Fix: the build disables the four start-up files Bun can load (`bunfig.toml`,
`.env`, `tsconfig.json`, `package.json`). ctest's `kationd-isolated`
(`daemon/scripts/checkIsolation.ts`) runs the built program in a folder with
planted files and fails if one is loaded.

### H2. kationd loads modules from node_modules of the folder it is started in

The build left two optional modules of dbus-next out of the program
(`--external=usocket --external=x11`). At run time dbus-next still asks for
`usocket` on every connection to the session bus, and Bun looks for it in
`node_modules` of the current folder and of each parent folder, then runs it.

- A `node_modules/usocket/index.js` anywhere above the current folder ran on
  every `kationd` command, and when the service started.
- As in H1, an editor of a shared folder can place it in the synced folder.

- The bundled OpenPGP library has the same pattern for a third module,
  `eckey-utils`, which it loads to sign or verify with secp256k1 and Brainpool
  keys when the runtime offers those curves. Bun 1.4.4 does not, so this one
  cannot be reached today; a later Bun could change that. Found by the
  independent review of the fix.

Reproduced: the planted `usocket` ran on `kationd status`, including from a
subfolder.

Fix: the build replaces `usocket` and `x11` with stubs inside the program
(dbus-next then uses a plain socket, as it already did in the packages), and
limits OpenPGP's loader to the modules built into Bun.
`daemon/test/build.test.ts` fails if the bundle can load anything else;
`kationd-isolated` covers `usocket` on the built program.

## Medium

### M1. The online view opens a file with the application its uploader chose

`kationd` reports each file's media type as stored in Proton Drive
(`daemon/src/service/entry.ts:48`) and the KIO worker passes it on
(`kde/kioworker/protondriveworker.cpp:86` and `:273`). The uploader's client
sets that type, so it need not match the name: a file named `photo.jpg` can
claim to be a Java archive.

KIO picks the application from the claimed type. It refuses to run remote
programs, scripts and `.desktop` files, but any other type opens in its default
application. Where such an application runs its input (a Java runtime
registered for `.jar` files, for example), one click on a harmless-looking name
in `protondrive:/` runs the attacker's code. The synced folder is not affected:
local files get their type from their name and content.

Needs: write access to a folder the user browses, a click, and a suitable
application installed. Not reproduced (no KDE build here).

Options:

1. Derive the type from the file name and report `application/octet-stream`
   when the extension is unknown, in `toEntry` (kationd already has
   `mediaTypeOf` for uploads) or in the worker with `QMimeDatabase`.
   Extensionless files then show as unknown.
2. As 1, but keep the stored type when the name gives none and the stored type
   is harmless (text, image, audio, video).
3. Keep the behaviour and document it.

## Low

- **L1. Partial downloads follow symbolic links.** `Download` writes to
  `<path>.kation-part`, and sync to `.<name>.<tag>.kation-part`, with a plain
  open (`daemon/src/service/driveService.ts:155`, `:172`, `:222`). A link
  planted at that name is written through; reproduced for both. Planting it
  takes local write access to the folder; in `/tmp`, the kernel's
  `protected_symlinks` and `protected_regular` settings block it on current
  distributions.
- **L2. File names shown as rich text.** The tray tooltip
  (`kde/app/tray.cpp:361`), the "Create a Public Link?" question and the "link
  copied" notification (`kde/dolphin/fileitemaction.cpp:119`, `:145`) insert a
  file name without escaping it. A crafted name can change what these say,
  including hiding the warning in the question.
- **L3. URLs from kationd opened without a check.** The sign-in and website
  URLs are passed to `QDesktopServices::openUrl` whatever their scheme
  (`kde/settings/settingswidget.cpp:216`, `:446`,
  `kde/dolphin/fileitemaction.cpp:69`); the command line checks for `https`.
- **L4. Data files are world-readable inside private folders.** Caches, the
  log, `clientUid.json` and `sync.sqlite` are created with mode 0644 and rely
  on their folder being 0700. The KIO worker can create `~/.cache/kation` first,
  with the default mode (`kde/kioworker/protondriveworker.cpp:116`).
- **L5. Signing out leaves traces.** `kationd.log` (paths of synced files),
  partial downloads, spool files and deleted rows in `sync.sqlite` stay on
  disk, while the D-Bus documentation says sign-out "deletes local data".
- **L6. Trash on other disks.** `<mount point>/.Trash-<uid>` is used without
  checking that the user owns it or that it is not a link
  (`daemon/src/sync/local.ts:113`): on a disk shared with other users, they can
  receive the files sync moves to the trash.
- **L7. Resumed downloads are checked less.** They skip the SDK's block hash
  and signed-manifest checks and compare the file's SHA-1 with the one in its
  encrypted attributes instead (`daemon/src/service/driveService.ts:153`). This
  catches corruption; it is weaker against a tampering server.
- **L8. Releases cannot be verified.** Packages have no checksums or build
  provenance; CI containers are named by tag (`archlinux:latest`,
  `fedora:43`, `debian:trixie`); `actions/checkout` keeps its token on disk
  during the build.
- **L9. Service start.** `kationd.service` sets no hardening option, and the
  autostart entries find `kationd` and `kation` through `PATH`
  (`daemon/src/sync/autostart.ts:77`, `kde/settings/trayautostart.cpp:63`).
- **L10. Dependencies.** `xml2js` 0.4.23, bundled through dbus-next, has a
  prototype-pollution advisory (GHSA-776f-qx25-q3cc); it only parses Kation's
  own interface description and the bus daemon's. The other `bun audit` results
  are in build-time packages. The `brace-expansion` overrides in
  `daemon/package.json` pin versions that are now flagged.
- **L11. Names printed as they are.** `kationd ls` and `kationd activity` print
  remote names unfiltered (`daemon/src/main.ts:158`, `:175`), and the log
  records them with their line breaks: terminal escape sequences, forged log
  lines.
- **L12. Link checks and use are separate steps.** Sync checks for symbolic
  links, then works by path (`daemon/src/sync/engine.ts:1261`). A local program
  swapping a folder for a link at the right moment gets through.
- **L13. `disable-gnome-keyring.sh` and PAM jumps.** The script comments out
  `pam_gnome_keyring` lines. If such a line sits between a `[success=N]` jump
  and its target, the jump lands one line further. Not seen in a stock PAM
  file; not tested.
- **L14. Over-long remote names.** A name longer than the file system allows
  (255 bytes) cannot be created, and sync then stays in the error state for as
  long as the item exists.

## What held up

- Hostile remote names (`..`, `a/b`, a NUL byte, `.directory`, the marker file
  name, partial-download names) never left the sync folder or replaced Kation's
  own files.
- Every D-Bus method rejected malformed arguments; none crashed the service.
- A download that fails the SDK's integrity checks is discarded, never moved
  into place.
- The session, the key password and the cache key are stored only in the
  keyring, and none is written to the log.
- SQL statements are parameterised; nothing builds a shell command from a file
  name.
- Workflows use pinned actions, minimal permissions and no `pull_request_target`.

## Also noticed (not a security issue)

`kationd` commands hang when `DBUS_SESSION_BUS_ADDRESS` names a socket that no
longer exists: `connectService` (`daemon/src/client.ts:37`) waits for
`getProxyObject`, which never returns after the connection error.
