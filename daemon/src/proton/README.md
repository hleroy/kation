# Code from the Proton Drive CLI

These modules come from the Proton Drive CLI (`cli/src` in
[ProtonDriveApps/sdk](https://github.com/ProtonDriveApps/sdk)), MIT licensed,
copyright Proton AG. They wire the Drive SDK to the account module: session
storage, encrypted caches, event cursors, HTTP hooks and log files.

Upstream: tag `cli/v0.9.0` (commit `df3a717b`), the same commit as the
`third_party/proton-drive-sdk` submodule.

Keep changes here minimal so upstream updates stay easy to merge. Every change
is marked with a `// Kation:` comment.

## Changes from upstream

- `credentials/constants.ts`: keyring service is Kation's app ID, so Kation
  never touches the official CLI's stored session.
- `telemetry/fileHandler.ts`: log file renamed to `kationd.log`.
- `credentials/index.ts`: optional wrapper around the session store, so
  kationd can start and report a clear error when the keyring is unavailable.
- `config.ts`: new; re-exports Kation's `Config` type.
- `telemetry/fileHandler.test.ts`: removed (it fakes Bun under Node's Jest and
  cannot run under `bun test`).
- `events/manager.ts` and its test: removed. It used the SDK's deprecated
  subscribe API, which keeps polling after sign-out; Kation polls with
  `iterateEvents` instead (`src/events.ts`). The event cursors (providers,
  lock, storage) are still the CLI's.

Not copied: the CLI commands, telemetry upload (Sentry and metrics), and Photos.
