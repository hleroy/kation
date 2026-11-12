<!--
SPDX-FileCopyrightText: 2026 Kation contributors
SPDX-License-Identifier: GPL-2.0-or-later
-->

# Plan: cut kationd.log noise and mask tokens (`fix/daemon-log-noise`)

## Context

A review of `~/.local/state/kation/kationd.log*` (87 k lines in 4 files, Nov 1–12; 47 k of them
on Nov 7, one bulk upload) found:

1. Routine Proton SDK detail at INFO: `[api]` 28 k lines, `[interface]` 22 k ("Getting node
   <uid>"), `[upload]` 11 k, `[download]` 1.5 k. Kation's own lines are 6 k. About 12 SDK lines per
   small file uploaded.
2. Rotation is 5 × 5 MB, so a bulk upload fills a rotated file in well under an hour and pushes
   out days of history.
3. SDK metrics are written as bare JSON lines (`{"time":…,"event":…}`) mixed in with the text log,
   with no level or tag: 17.8 k lines (`performance` 12.5 k with 15-decimal ms values, `upload`
   5.2 k, `download` 92, `volumeEventsSubscriptionsChanged` 12, `apiRetrySucceeded` 4).
4. The SDK logs the block upload token (a JWT valid for 3 h) as the block's prefix:
   `block 1:eyJ…` (5.5 k lines of 500+ characters). It also appears in the SDK's WARNING retry
   lines, so filtering by level alone is not enough. Thumbnail tokens get the same treatment in
   the SDK (`internal/upload/streamUploader.ts:434`, `internal/download/thumbnailDownloader.ts:213`).
   The About tab now points users at this file for bug reports.
5. The "Sync pass" line lists every dirty folder: one line was 10.6 KB.
6. A DNS failure (`getaddrinfo EAI_AGAIN`) is logged as ERROR with a stack: at startup by the
   account SDK (10 lines, then again as a WARNING by `session.ts`), and by the SDK's API service
   as `failed, retrying once` with `Stack:` / `undefined`. It is a normal transient condition.
7. Two smaller defects in error lines: an INFO "stopped on purpose" line still carries the abort's
   stack, and a failed session refresh prints `Error: [object Response]`.
8. Naming: Kation's own module is called `telemetry.ts` / `initTelemetry`, after the SDK class it
   configures. Nothing leaves the computer (README.md:112 says so), but the name suggests the
   opposite to someone auditing the code.

Goal: a module name that says what it does; failures, Kation's own events and the "Uploading
/path" lines stay at INFO; SDK chatter and metrics move to DEBUG (`KATION_LOG_LEVEL=DEBUG` brings
it all back); one text format; no tokens. `daemon/src/proton/` and `third_party/` stay untouched:
everything is done in kationd's logging module.

## Step 0: rename the module to "logging" (own PR, merged first)

Branch `refactor/daemon-logging-name` from `origin/main`, PR title
`refactor(daemon): rename the telemetry module to logging`. Kept apart from the fix so that git
records a pure rename (the fix rewrites much of the file, which would break `git log --follow`) and
the fix's diff shows only behaviour. No behaviour change, no changelog line.

| Now                                                         | After                                             |
|-------------------------------------------------------------|---------------------------------------------------|
| `daemon/src/telemetry.ts`                                   | `daemon/src/logging.ts` (`git mv`)                |
| `daemon/test/telemetry.test.ts`                             | `daemon/test/logging.test.ts` (`git mv`)          |
| `initTelemetry(config)`                                     | `initLogging(config)`                             |
| returned key `telemetry` (the SDK `Telemetry` instance)     | `localLog`                                        |
| `flushTelemetry` (`drive.ts:35,99`)                         | `flushLog`                                        |
| doc comment "Local-only telemetry: logs and SDK metrics…"   | "Logging to a local file: … Nothing is sent to Proton or anywhere else. The SDK calls the object it logs through its `telemetry`." |

Callers: `daemon/src/drive.ts:22,35,36,56,82,99` and `daemon/src/service/serve.ts:17,195,196`. The
SDK option stays, since it is the SDK's name: `telemetry: localLog`.

What keeps the word, because it is not ours to rename: the SDK's `Telemetry` class and its
`@protontech/drive-sdk/telemetry` import path, the `telemetry` option of the SDK clients, and the
copied `daemon/src/proton/telemetry/` folder (CLAUDE.md: never touch `src/proton/`). The header of
`logging.ts` says so in one line, so a reader who greps "telemetry" lands on the explanation.

Verification: `(cd daemon && bun test && bun x tsc --noEmit -p .)`, full ctest, `pre-commit run
--all-files`; `git grep -i telemetry -- daemon/src ':!daemon/src/proton'` shows only SDK imports,
the `telemetry: localLog` option and the explanatory comments.

## Branch

`fix/daemon-log-noise` exists, created from `origin/main` (b83a204). Rebase it on `main` once
step 0 is merged; it has no commits yet.

## Changes

New names introduced below follow the same rule: `metricsAsLogs`, `safeLog`, logger name
`metrics` (the lines read `[metrics] …` in the local log).

### 1. Per-logger levels — `daemon/src/logging.ts`

- `const QUIET_SDK_LOGGERS = ['api', 'interface', 'upload', 'download']`. These four are 99.9 % of
  the SDK's INFO lines; the others seen (`events` 28 lines, `sharing` 2) are rare and useful.
- Build the `LogFilter` once and reuse it for metrics (step 2):
  `new LogFilter({ globalLevel: config.logLevel, loggerLevels })`, where `loggerLevels` maps those
  names to `WARNING` only when `config.logLevel === INFO`. `LogFilter.filter` checks the global level
  first and then the logger level, so at DEBUG an empty map is needed for the SDK lines to come back.
- Nothing is lost on failure: the SDK logs non-2xx responses, retries and transfer failures at
  WARNING/ERROR (`internal/apiService/apiService.ts:328-356`, `internal/upload/streamUploader.ts:480-484`).
  `cancellationIsNotAnError` still works: the ERROR passes the filter, then the wrapper demotes it.

### 2. Metrics as ordinary log lines — `daemon/src/logging.ts`

Stop passing `fileHandler` as a metric handler (its `onEvent` writes the raw JSON). Add
`metricsAsLogs(filter, handlers): MetricHandler` that turns each `MetricRecord` into a `LogRecord`
(`loggerName: 'metrics'`, message `${eventName} ${JSON.stringify(rest)}`), runs it through
`filter.filter()` and hands it to the same `logHandlers` (so printable-escaping and token masking
apply). Level by event (types in `client/js/src/interface/telemetry.ts`):

| Event                                                                                              | Level   |
|----------------------------------------------------------------------------------------------------|---------|
| `performance`; `upload`/`download` without `error`                                                 | DEBUG   |
| `upload`/`download` with `error`, `decryptionError`, `verificationError`, `blockVerificationError` | WARNING |
| `apiRetrySucceeded`, `debounceLongWait`, `volumeEventsSubscriptionsChanged`, unknown               | INFO    |

The `JSON.stringify` replacer turns an `Error` into its message (they serialise as `{}`, or as
their enumerable `code`/`path`/`syscall` for fetch errors, as seen in `apiRetrySucceeded.previousError`),
rounds non-integer numbers to 1 decimal and leaves everything else (a status number like `502`,
strings) alone. Cancelled transfers produce no metric (`internal/upload/telemetry.ts:47-51`), so a
pause adds no WARNING.

### 3. Mask tokens — `daemon/src/logging.ts`

Extend `printableLog` (rename to `safeLog`; its only users are this module and its test). After
`printable()`, apply `maskTokens()` to the message, and to the error's message and stack (reuse the
copy path of `printableError`, which already rewrites both; make it copy when either escaping or
masking changed the text). `maskTokens` does two replacements:

- By shape: `/(?<![\w-])eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g` → `<token>` (the JWT anywhere,
  including error text). A node UID that happens to contain `eyJ` has no dots and is left alone
  (seen in the log); the boundary and minimum lengths keep file names such as `HeyJoe.v1.2.txt`.
- By position, for tokens that may not be JWTs:
  `/\b(block \d+:|thumbnail (?:type \S+ to )?)[\w.~+\/=-]{16,}(?=: )/g` → `$1<token>`. The token
  must be followed by `: `, as in the SDK's prefixes, so a path like `/Photos/thumbnail <long name>`
  is not masked.
  `block 3: Skipping hash check` (download side, no token) does not match: a space follows the colon.

Result: `block 1:<token>: Upload failed #1, retrying`.

In the non-`Error` branch of `printableError`, a `Response` becomes `HTTP ${status} ${statusText}`
instead of `[object Response]` (the account SDK does `logger.error('Failed to refresh session',
response)`, `incubating/account/js/src/apiClient.ts:145`).

### 4. Transient network errors are warnings — `daemon/src/logging.ts`

New wrapper `networkErrorIsWarning(handler)`, alongside `cancellationIsNotAnError`: an ERROR whose
error, or any error in its `cause` chain (depth ≤ 5), is a network failure becomes a WARNING
`${message}: ${error.message}` with `error` dropped (no stack). Network failure = an instance of the
SDK's `ConnectionError` (`client/js/src/errors.ts:142`), or `code`/message matching `EAI_AGAIN`,
`ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENETUNREACH`, `EHOSTUNREACH` (in the message
only at its start, as in `getaddrinfo EAI_AGAIN host`, so a path holding such a word does not
count). An abort is never treated as a network error. Match on the message as well as `code`: `printableError`'s copy keeps `name`, `message`, `stack` and `cause` but
not `code`.

Wrapper order, for both the file and the console handler:
`safeLog(networkErrorIsWarning(cancellationIsNotAnError(handler)))`. `safeLog` is outermost so it
runs first: the message the network wrapper builds from `error.message` is already escaped and
masked.

This covers both forms seen in the log:

- `ERROR [kationd] Error loading user data` + 10-line stack (`incubating/account/js/src/addresses.ts:244`)
  → one WARNING. The `session.ts:225` WARNING stays: it is Kation's own line, and the SDK one cannot
  be removed without editing `third_party/`. The pair becomes two one-line warnings.
- `ERROR [api] GET …: failed, retrying once` + `Error:` + `Stack:` + `undefined`
  (`apiService.ts:340`) → `WARNING [api] GET …: failed, retrying once: getaddrinfo EAI_AGAIN …`.

### 5. Shorter sync-pass line — `daemon/src/sync/engine.ts:379`

List at most 10 folders, then `… (+N more)`; log the full list at DEBUG on the next line when it was
truncated (worded `All folders of the pass: …`, so that `grep "Sync pass" | tail -1` still finds the INFO line). Keep the `Sync pass: full (local)` prefix that `docs/e2e-test-plan.md` greps, and the
` [paused!]` suffix.

### 6. No stack on a transfer stopped on purpose — `daemon/src/logging.ts`

`cancellationIsNotAnError` demotes to INFO with `…(stopped on purpose)` but spreads the record, so
the formatter still appends `Error: Operation aborted`, `Stack:` and the frames. Set
`error: undefined` in the demoted record.

### Not changed

- Rotation stays 5 × 5 MB: with steps 1–2, Nov 7 would have written about 5.5 k lines instead of 47 k.
- "Uploading /path" (5.1 k lines) stays at INFO: it is the line people need, and paths are the
  user's own data.
- Long node UIDs: after step 1 they only remain in SDK warnings/errors, where the full ID is useful.
- `WARNING [download] … Skipping hash check` (222 lines, Nov 1 only): logged per block by
  `unsafeDownloadToStream`, which kationd no longer calls (`driveService.ts:191` uses
  `downloadToStream`).
- The `Refreshing session` / `missing RefreshToken` / `401` / `ERROR [events] Invalid access token`
  loop after a sign-out (about 90 lines): Nov 1 only, 0.1.0-alpha builds, not seen since. If it
  comes back it is a behaviour bug (polling after sign-out), not a logging one.
- `Stack:` followed by `undefined` for an error without a stack comes from the SDK's
  `BasicLogFormatter` (`third_party/`). The cases seen are all network errors, which step 4 handles.
- A wrapper demotes after the filter has run, so with `KATION_LOG_LEVEL=ERROR` a demoted WARNING or
  INFO line is still written. Already true of `cancellationIsNotAnError`; harmless.
- Tokens already in existing log files expired 3 h after they were written.

## Docs and changelog

- `CHANGELOG.md` `[Unreleased]` → new `### Changed` section: "The log keeps Proton SDK details
  (each API call, block uploads, timings) for `KATION_LOG_LEVEL=DEBUG`, so a large upload no longer
  pushes days of history out of it; upload tokens are masked."
- `README.md:116`: one line that `DEBUG` adds the Proton SDK's API calls and metrics.
- `docs/e2e-test-plan.md:161`: "should end with" → "should contain" `full (local)`; drop the now
  unneeded `grep -v '^{'` at line 266.
- No user-visible KDE strings change, so no `po/update.sh`.
- Commit `docs/plans/daemon-log-noise.md` with the change (it has its SPDX header).

## Tests — `daemon/test/logging.test.ts` (existing file, same style as the `cancellationIsNotAnError` tests)

- Filter: at INFO, an `api` INFO record is dropped, an `api` WARNING and a `kationd` INFO kept; at
  DEBUG all three kept.
- Metrics: `performance` dropped at INFO and written at DEBUG as `[metrics] performance {…}` with
  rounded numbers; `decryptionError` with an `Error` written at WARNING with the error's message;
  `apiRetrySucceeded` with `previousError: 502` and with an `Error` carrying `code`; no line in the
  file starts with `{` (end-to-end through `initLogging`, like the `clearLog` test).
- Tokens: a JWT in the message, the error message and the stack becomes `<token>`;
  `block 2:opaque-token-0123456789: Uploaded` and `thumbnail type 1 to opaque-token-0123456789:
  Upload started` are masked; `block 3: Skipping hash check` and a node UID containing `eyJ` are
  unchanged. The existing "cannot be forged" test still passes after the rename.
- Response: `logger.error('Failed to refresh session', new Response(null, { status: 400 }))` writes
  `HTTP 400`, not `[object Response]`.
- Network: an ERROR with `AccountApiError`-like `{ cause: Object.assign(new Error('getaddrinfo
  EAI_AGAIN x'), { code: 'EAI_AGAIN' }) }` becomes a WARNING without `error`; so does an error
  whose only sign is `EAI_AGAIN` in its message (the `[api]` form); a plain `Error('boom')` stays
  ERROR with its error.
- Order, end-to-end through `initLogging`: an ERROR whose network error message holds a JWT and a
  newline gives one WARNING line with `<token>` and `\n` escaped.
- Cancellation: extend the existing test to expect `error` undefined on the demoted record.
- Sync pass, in `test/syncEngine.test.ts`: `setup({ logger: { ...silentLogger, info: … } })` (the
  pattern at line 247) with 25 dirty folders gives a line with 10 folders and `(+15 more)`. Extract
  the formatting into a small exported function if driving 25 dirty folders through the engine is
  awkward.

## Verification

1. `(cd daemon && bun test && bun x tsc --noEmit -p .)`, then the full `ctest --test-dir build
   --output-on-failure` and `pre-commit run --all-files`.
2. Manual: build, restart kationd with the default level, copy a folder of ~50 small files into the
   synced folder; `kationd.log` should gain roughly one "Uploading" line per file, no `{` lines, no
   `eyJ`, no `[api]`/`[interface]` INFO lines. Pause sync during a large download: one INFO
   "stopped on purpose" line, no stack. Restart with `KATION_LOG_LEVEL=DEBUG` and repeat the copy:
   API, interface and `[metrics]` lines are back, tokens still masked
   (`grep -c 'eyJ[A-Za-z0-9_-]*\.' kationd.log` is 0).
3. Review the diff with the `code-review` skill in a fresh subagent per CLAUDE.md; commit
   `fix(daemon): keep proton sdk details out of the info log and mask upload tokens`, open the PR.
