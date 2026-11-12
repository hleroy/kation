# Kation

Kation is an unofficial Proton Drive client for KDE Plasma. It is not
affiliated with or endorsed by Proton AG.

Status: initial release. Sign-in, the online view, folder sync and the
Plasma integration are done and tested on a desktop with a real Proton
account. See [ROADMAP.md](ROADMAP.md) for what the initial release includes
and ideas for what comes next.

## What it does

Kation puts your Proton Drive on your KDE desktop, in two ways:

- **Browse it in Dolphin.** Proton Drive shows up under Network in Dolphin
  and in the Open and Save dialogs of your apps. You work directly with
  the files online, without keeping a copy on your computer.
- **Keep a folder in sync.** Turn on sync and a `Proton Drive` folder in
  your home folder stays the same as your Proton Drive: what you change
  on one side appears on the other. It works offline and catches up when
  you are back online.

A tray icon shows whether everything is up to date, and icons in Dolphin
show which files are synced. Kation signs you in through Proton's own web
page, so it never sees your password.

Sync is careful with your files:

- Nothing is deleted for good: deleted files go to the Proton Drive trash
  or your computer's Trash.
- If a file was changed in both places, you keep both versions.
- Sync pauses instead of deleting when something looks wrong: many files
  deleted at once, the sync folder missing (an unplugged disk, say), or a
  different account.

The details are in [How folder sync works](docs/sync.md).

## Installing

Download the package for your distribution from the
[latest release](https://github.com/hleroy/kation/releases/latest) and
install it. Releases after 0.2.0 come with `SHA256SUMS` and build
provenance: check the package you downloaded first (the second command needs
the GitHub CLI).

```sh
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify <package file> --repo hleroy/kation \
    --signer-workflow hleroy/kation/.github/workflows/release.yml
```

```sh
sudo apt install ./kation_*_amd64.deb            # Debian 13
sudo dnf install ./kation-*.fc43.x86_64.rpm      # Fedora 43
sudo pacman -U kation-*-x86_64.pkg.tar.zst       # Arch Linux
systemctl --user daemon-reload
```

Each package is built for that distribution release. On another
distribution or release (Ubuntu, KDE neon, …), build Kation from source: see
[DEVNOTES.md](DEVNOTES.md).

There is no Flatpak or Snap: most of Kation runs as plugins inside the
system's Dolphin and System Settings, which a sandboxed package cannot
provide (see [ROADMAP.md](ROADMAP.md#out-of-scope)).

## Using it

1. Enable the Secret Service in KWallet: System Settings → KDE Wallet →
   "Use KWallet for the Secret Service interface".
   If another package pulled in GNOME Keyring and it now answers in place of
   KWallet, [`scripts/disable-gnome-keyring.sh`](scripts/disable-gnome-keyring.sh)
   stops it from starting (nothing is uninstalled; `--undo` restores it).
2. Start **Kation** from the application launcher and click **Sign In…**.
3. Open `protondrive:/` in Dolphin (or click **Open Online View**). It is
   also listed under Network.
4. To sync a folder, click **Turn On Sync** in the Kation window. The first
   sync downloads all of "My files", so check your free disk space, or
   untick big folders in **Folders to Sync** first.
5. Restart Dolphin once after installing, so it loads the emblems and the
   **Proton Drive** context menu.

`kationd` also has commands for scripts and troubleshooting. They go through
the running service, so they never compete with it for the Proton session:

```sh
kationd status
kationd ls /Documents
kationd sync            # status; also: on, off, pause, resume, now
kationd sync exclude /Videos   # stop syncing a folder (include, excluded)
kationd sync limits 500 0      # upload limit in KiB/s, no download limit
kationd activity               # what sync did recently
kationd link --create /Docs/report.pdf   # public link (also a local path)
kationd weburl /Docs/report.pdf          # address in the Proton Drive website
kationd login | logout
```

Add `--json` for machine-readable output and `--verbose` to see logs.

| What | Where |
|---|---|
| Session | Your keyring (KWallet), entry `com.hleroy.Kation` |
| Encrypted metadata caches | `~/.cache/kation` |
| Client ID, event cursors, sync state | `~/.local/share/kation` |
| Sync settings and speed limits | `~/.config/kation/sync.json` |
| Tray settings | `~/.config/kationrc`; autostart entry `~/.config/autostart/com.hleroy.Kation.tray.desktop` |
| Logs | `~/.local/state/kation/kationd.log` |

Signing out deletes the session, the caches, the sync state, the log and
partial downloads. The files in the sync folder and the settings stay.

Logs stay on your computer; Kation sends no telemetry.

Environment variables for `kationd`:

- `KATION_LOG_LEVEL`: `DEBUG`, `INFO` (default), `WARNING` or `ERROR`. `DEBUG` adds
  the Proton SDK's details: each API call, block transfers and metrics.
- `KATION_CREDENTIALS_STORE`: `keychain` (default), `pass`, or
  `unsafe_file` (plaintext, for tests only).

`kationd` runs as a systemd user service, so a variable set in a terminal does not
reach it. To get a `DEBUG` log, for a bug report for example:

```sh
mkdir -p ~/.config/systemd/user/kationd.service.d
printf '[Service]\nEnvironment=KATION_LOG_LEVEL=DEBUG\n' \
  > ~/.config/systemd/user/kationd.service.d/debug.conf
systemctl --user daemon-reload
systemctl --user restart kationd.service
```

Reproduce the problem, then go back to the default level:

```sh
rm ~/.config/systemd/user/kationd.service.d/debug.conf
systemctl --user daemon-reload
systemctl --user restart kationd.service
```

The log holds the names of your files and folders: read it before sharing it.

## Contributing

Building from source, the development setup, tests and releases are
described in [DEVNOTES.md](DEVNOTES.md).

## Proton's rules for third-party apps

Proton allows its SDK in personal, non-commercial projects that follow its
[guidelines](https://github.com/ProtonDriveApps/sdk#usage-guidelines-for-personal-projects).
Kation follows them:

- It identifies itself honestly, as `external-drive-kation@<version>`.
- It only talks to Proton's official servers.
- It uses Drive events rather than polling.
- It uses no Proton logos or branding.
- It states that it is unofficial wherever you sign in.

## License

Kation is licensed under GPL-2.0-or-later. Code copied from Proton's SDK
repository is MIT licensed. See [REUSE.toml](REUSE.toml) and
[LICENSES](LICENSES).
