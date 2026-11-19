---
name: dependabot-triage
description: Triage open Dependabot PRs on hleroy/kation. Research each bump against its upstream changelog and the published artifact, judge the real impact on kationd and the workflows, label every PR SAFE TO MERGE / REVIEW NEEDED / DO NOT MERGE with a reasoning comment, and squash-merge the safe ones. Use when asked to review, triage or clear the Dependabot queue, and as the weekly scheduled routine.
---

# Dependabot triage

Review every open Dependabot PR on `hleroy/kation`, classify it, and merge what is
genuinely safe. This runs unattended every week, so **the burden of proof is on
merging**: when the evidence is thin, escalate rather than merge.

This file is the **only** triage rubric. The weekly routine's prompt holds just its
setup and a short list of absolute bans, and defers to this file for every verdict
rule, so change the rules here and nowhere else. Read `CLAUDE.md` too: its rules
(the copied CLI code, the SDK pin, Conventional Commits) are invariants here.

## Tooling: pick the transport first

**In the scheduled cloud routine, do not use `gh`.** It is missing or not
authenticated there. Use the `mcp__github__*` tools; load them first with ToolSearch:
`select:mcp__github__list_pull_requests,mcp__github__pull_request_read,mcp__github__issue_read,mcp__github__issue_write,mcp__github__add_issue_comment,mcp__github__merge_pull_request,mcp__github__get_label`.
Locally, an authenticated `gh` works too. The verdicts and the hard rules are the
same either way; only the transport differs.

**If neither transport is available, stop at once.** Do not research anything, and do
not write verdicts you cannot apply. Send one push notification,
"Dependabot triage BLOCKED — <what is missing>", and end the run.

| Operation | With `gh` (local) | Without `gh` (cloud routine) |
|---|---|---|
| List open PRs | `gh pr list --author 'app/dependabot' --state open --json number,title,url` | `mcp__github__list_pull_requests` (`state: "open"`, then keep `user.login == "dependabot[bot]"`) |
| PR facts | `gh pr view <n> --json …` | `mcp__github__pull_request_read` `method: "get"` |
| Check runs | (included in `statusCheckRollup`) | `mcp__github__pull_request_read` `method: "get_check_runs"` (not `get_status`) |
| Changed files | `gh pr diff <n> --name-only` | `mcp__github__pull_request_read` `method: "get_files"` |
| Diff | `gh pr diff <n>` | `mcp__github__pull_request_read` `method: "get_diff"` |
| Current labels | `gh pr view <n> --json labels` | `mcp__github__issue_read` `method: "get_labels"` |
| Label exists? | `gh label list` | `mcp__github__get_label` |
| Label | `gh api -X POST repos/hleroy/kation/issues/<n>/labels -f 'labels[]=<verdict>'` | `mcp__github__issue_write` `method: "update"` |
| Comment | `gh pr comment <n> --body "…"` | `mcp__github__add_issue_comment` |
| Merge | `gh pr merge <n> --squash` | `mcp__github__merge_pull_request` (`merge_method: "squash"`) |

Traps worth knowing before you hit them:

- **`get_status` returns nothing useful here**: every check is a check run, not a
  legacy commit status. Use `get_check_runs`.
- **A first `mergeable_state: "unknown"` is a cache miss**: GitHub computes it lazily.
  Re-read the PR once or twice before drawing a conclusion.
- **`mcp__github__issue_write` replaces the whole label set**, it does not add to it.
  Read the PR's current labels first and pass them back with the verdict label, or you
  will silently strip `dependencies` / `javascript` / `github_actions`.
- **The verdict labels must already exist.** Check with `get_label` before the first
  label call. If one is missing, do not create it and do not substitute another: post
  the comment, leave the PR unmerged, and report the missing label. (GitHub creates a
  missing label silently on some write paths, which is exactly what must not happen.)
- **`get_files` / `get_diff` on a PR that rewrites `daemon/bun.lock` can overflow the
  token limit** and get spilled to a file. Read the spilled file with `grep` rather
  than whole.
- **A `403 Resource not accessible by integration` means the GitHub App installation
  does not cover this repo**, not that the rubric forbids the write. Report it plainly
  and leave the verdict unapplied; never work around it.

## Scope

Only PRs authored by `dependabot[bot]`. Never touch a human-authored PR: do not
label it, comment on it, or merge it. If there are none, send the push notification
saying so and stop.

What Dependabot manages here (`.github/dependabot.yml`), and so what a PR can
legitimately touch:

- **`github-actions`**, monthly, one grouped PR (`github-actions`) plus security
  updates. It may edit only `uses:` lines (SHA and `# vX.Y.Z` comment) in
  `.github/workflows/*.yml`.
- **`bun` in `/daemon`**, monthly: minor and patch bumps grouped (`bun`), each major
  as its own PR, plus security updates (`bun-security`). It may edit only
  `daemon/package.json` and `daemon/bun.lock`.

Not managed by Dependabot, so a PR that changes any of these is an anomaly: the SDK
submodule `third_party/proton-drive-sdk`, the `file:` dependencies on it,
`@protontech/crypto` (ignored on purpose), `daemon/.bun-version`, the container images
pinned by digest in the workflows, and the pre-commit hook revs.

## Hard rules

These override every verdict below.

- **Squash only, into `main` only.** Never commit to `main` directly.
- **Never push commits to a Dependabot branch.** If a PR needs a code change to be
  correct, that is REVIEW NEEDED: describe the change, do not make it.
- **Never modify the checkout**: no edits to `dependabot.yml`, workflows, project
  files or `CHANGELOG.md`. Scratch work goes in a temporary directory outside it.
- **A PR whose checks are not all green is never SAFE TO MERGE**, however benign the
  bump looks. Pending or queued counts as not green: leave it unlabeled and report it
  as "still running" rather than guessing.
- **Never re-label or re-merge a PR that already carries one of the three verdict
  labels**, unless new commits landed after the label was applied (Dependabot rebases
  push new commits). Re-running the routine must be idempotent.
- **CI is the gate; do not run ctest.** The suite needs Qt 6 and KDE Frameworks 6,
  which a cloud session does not have. Read the CI result. Targeted scratch runs for
  Step 2c are the only exception.

## Step 1: gather the facts

For each PR, read its facts, its check runs, its changed files and its diff.

Record:

- every constituent dependency with its **exact old → new version**, whether it is a
  `dependencies` (shipped) or `devDependencies` entry, or the action and every
  workflow that uses it;
- the **publication date of each new version**: the npm registry's `time` field
  (`https://registry.npmjs.org/<pkg>`), or the upstream tag or release date for an
  action;
- the files touched, and mergeability (`mergeable` true and `mergeable_state` clean);
- the conclusion of every check run: `Lint (pre-commit)`,
  `Build and test (Fedora, KDE Frameworks 6)`, `pr-title`, `GitGuardian Security
  Checks`. All four must be present and `success`. `pr-title` can appear more than
  once (one run per triggering event); every run must succeed.

A grouped PR ("… in the bun group") must be decomposed: the PR body lists each
`Updates X from A to B`, and the `daemon/bun.lock` diff is the ground truth. Every
constituent is researched on its own.

**Account for every lockfile change.** Every package entry that changes in
`daemon/bun.lock` must be a listed constituent or one of its own dependencies. A
package that appears for the first time is a **new supplier**: name it in the comment
and research it like a constituent. Check that each package pinned in the `overrides`
block of `daemon/package.json` still resolves at or above its override.

### Flag fresh releases

The cooldowns in `dependabot.yml` mean a routine version update never carries a
release younger than: **7 days** for actions and bun patches, **14** for bun minors,
**30** for bun majors. A constituent younger than its cooldown therefore bypassed it,
almost always because it is a **security update** (those skip the cooldown by design)
or because someone triggered it by hand. That is exactly the release a supply-chain
attack would ship: an advisory creates urgency, and nobody has looked at the artifact
yet. Mark each such constituent **fresh** and run Step 2b on it on top of the normal
research. The same applies to any PR that links a GHSA/CVE advisory or says it fixes a
vulnerability, whatever the release's age.

## Step 2: research each bump (mandatory, no shortcuts)

For **every** constituent, across the **exact range** old → new:

a. Fetch the upstream changelog or release notes **covering the whole range**: GitHub
   Releases, `CHANGELOG.md`, the npm page. Search the web when it is not obvious where
   they live. A range spanning several releases means reading all of them, not just the
   newest. Dependabot's embedded notes are truncated and cover only the newest release;
   follow the compare link instead.
b. Extract breaking changes, removed, renamed or deprecated APIs, changed defaults and
   behavioral changes across that range.
c. Determine whether any of them touch **what Kation actually uses**: grep `daemon/src`,
   `daemon/test`, `daemon/scripts` and the config files (`daemon/tsconfig.json`,
   `daemon/biome.jsonc`, the workflows) for the affected imports, calls, options and
   keys. Include `daemon/src/proton/` in the grep (it is read-only, but it runs).
   **A breaking change Kation never exercises is not relevant; say so explicitly**,
   naming what you grepped for and that it was absent.

Never substitute an assumption ("patch bumps are usually fine") for step (a).

### When there is no changelog, diff the artifacts

A missing changelog is where you stop reading *about* the release and read the release
itself. The published artifact is what actually gets installed; prefer it over
reconstructing the change from repository commits.

For an npm package, take both versions' `dist.tarball` URLs from
`https://registry.npmjs.org/<pkg>/<version>`, download them into a scratch directory,
unpack each with `tar -xzf`, and `diff -ru` the two `package/` trees. Read three things:

1. **The real behavioral changes.** Filter out typing churn, docs, formatting and
   build-output noise first; what remains is usually a handful of lines.
2. **Renamed or moved internals and entry points** (`main`, `exports`, `bin`). Grep
   Kation for each.
3. **`package.json` metadata**: new or raised `dependencies` (a new transitive
   supplier, or a floor above what `bun.lock` resolves), `engines`, and any new or
   changed `preinstall` / `install` / `postinstall` / `prepare` script.

A bump verified this way can be SAFE TO MERGE without a changelog. Say in the comment
that the evidence came from an artifact diff, and name the changes you found. If the
artifact cannot be obtained, or the diff shows changes whose impact you cannot resolve,
it stays REVIEW NEEDED.

## Step 2b: extra scrutiny for fresh and security releases

Mandatory for every constituent flagged in Step 1. The question is no longer only
"does this break us?" but "is this release what it claims to be?". Record each answer
in the comment.

1. **Confirm the advisory.** Open the linked GHSA/CVE. Check that it affects the
   version we are leaving, that the new version is its first patched version (or the
   nearest one), and whether the vulnerable code path is one Kation reaches: grep for
   it. A security bump that skips far past the first patched version pulls in more
   fresh code than the fix needs; say so.
2. **Diff the artifact, always**, even when a changelog exists: release notes are
   written by the same account that would publish a malicious build. Beyond the usual
   review, look for install-time or import-time execution, new network or
   `child_process` / `Bun.spawn` use, encoded or obfuscated blobs (`eval`,
   `new Function`, long base64 strings), new native binaries, and new dependencies.
   Bun runs a dependency's install scripts only for `trustedDependencies` (Kation lists
   none) and Bun's built-in allowlist of popular packages, so a new install script is
   a red flag whether or not it would run. The fix should be **small and match the
   advisory**; anything unrelated to it in a security release is a red flag.
3. **Check provenance.** The release must match upstream: a tag or GitHub release on
   the project's repository, published the same way as the previous releases. On npm,
   compare the new version's publisher (`_npmUser`) and provenance attestation
   (`dist.attestations`, `https://registry.npmjs.org/-/npm/v1/attestations/<pkg>@<version>`)
   with the previous release's: dropped provenance or a different publisher is a red
   flag. For an action, the new SHA must be the commit the upstream tag points to
   (`git ls-remote --tags https://github.com/<owner>/<repo>.git`, taking the `^{}`
   line for an annotated tag).
4. **Check it has not already been pulled**: an npm `deprecated` message or an
   unpublished version, an advisory against the *new* version
   (`https://api.osv.dev/v1/query`, ecosystem `npm`), and upstream issues reporting a
   compromised or broken release.

Verdict impact:

- A fresh release can be **SAFE TO MERGE** only when all four checks pass cleanly and
  Step 2 found nothing. The comment must say it is fresh, how old it is, and what was
  verified.
- Any check you could not complete makes it **REVIEW NEEDED**, naming the release's
  age: the maintainer can wait out the cooldown or merge after their own look.
- Anything suspicious (unexplained code, provenance mismatch, unexplained new
  dependency, deprecated or pulled) is **DO NOT MERGE**. Say exactly what you saw.

## Step 2c: major bumps

A major bump is not disqualifying on its own: Step 2 decides whether the breakage
reaches Kation. But a major needs **more evidence** than a minor. This applies to a
semver major of an npm package, including a `0.x` minor (`0.10 → 0.11`), and to an
action `vN → vN+1`.

A major constituent can be SAFE TO MERGE only when **all** of these hold, each
recorded in the comment:

1. **The full upgrade or migration guide was read** for every major in the range, at
   its source (the upstream docs or release notes at that tag). The PR body, a search
   snippet or a summary does not count. List each breaking change, what you grepped
   for, and whether it was found.
2. **It is a single major step.** A range that skips a major (3 → 5) is REVIEW NEEDED.
3. **The new version has been public long enough**: 30 days for an npm semver major
   (the bun major cooldown), 14 days for a `0.x` minor or an action, verified against
   its publication date. An `.0.0` often gets a quick `.0.1` regression fix. An
   unverified date is REVIEW NEEDED.
4. **CI really exercises it** (see "Ask what CI can actually see"), or you produced
   your own evidence: clone the repository into a scratch directory, check out the PR
   head, run `git submodule update --init --depth 1 third_party/proton-drive-sdk`,
   then `bun install --frozen-lockfile` and a targeted script or test in `daemon/`, on
   the old and the new version, and compare the results. That needs the Bun from
   `daemon/.bun-version`; if you cannot get it, or cannot produce the evidence, it is
   REVIEW NEEDED.
5. **The package is not on the always-review list**: `dbus-next`, and every
   SDK-mirrored package (Step 3). A major of any of these is never SAFE TO MERGE, and
   the Step 3 rules that make some of them DO NOT MERGE still apply.

The cost of a wrong call is bounded: merging to `main` does not release anything (only
a `vX.Y.Z` tag does), and the Saturday run leaves the weekend to revert. That is why a
verified major may merge unattended. It is not a reason to relax any of the five checks.

## Step 3: weigh it against Kation's invariants

Flag a bump that plausibly touches any of these, even when CI is green.

- **Shipped versus development dependencies.** `dependencies` are compiled into the
  `kationd` executable (`bun build --compile`), which ships in the packages and runs
  with the user's Proton session and keys. `devDependencies` run in CI and on the
  developer's machine. Both matter for supply chain; a shipped one also matters for
  users, so weigh "what CI can see" for it with extra care.
- **The SDK and the copied CLI code.** `third_party/` and `daemon/src/proton/` must
  never change (`CLAUDE.md`), and the submodule stays pinned to a release tag. A PR
  that touches either, or moves the submodule pointer, is **DO NOT MERGE**.
- **`@protontech/crypto`** is pinned exactly and ignored in `dependabot.yml`, because
  `patchedDependencies` applies the SDK's patch to exactly `2.0.0`. A PR that changes
  its version, or the `patchedDependencies` block, is **DO NOT MERGE**.
- **SDK-mirrored packages: `@noble/hashes`, `ky`, `ttag`.** Kation does not import
  them itself (only `daemon/src/proton/` imports `ky`); they are listed because the SDK
  packages and the copied CLI code need them, and mirror the ranges in
  `third_party/proton-drive-sdk/{cli,client/js,incubating/account/js}/package.json` at
  the pinned tag. Run `git submodule update --init --depth 1 third_party/proton-drive-sdk`
  and read those files. A new version **outside** the range upstream declares is
  **DO NOT MERGE**: it moves with the next SDK bump. Say so in the comment and suggest
  adding a major-version `ignore` to `dependabot.yml` (for the maintainer to do). Inside
  the range, the normal rubric applies, but CI never calls Proton's API, so green CI is
  weak evidence for these.
- **`overrides`** in `daemon/package.json` pin vulnerable transitive packages
  (`@xmldom/xmldom`, `brace-expansion`, `tmp`, `xml2js`) to fixed versions. A PR that
  edits or removes an override is REVIEW NEEDED; a lockfile that resolves an
  overridden package below its override is DO NOT MERGE.
- **`dbus-next`** (pinned exactly) carries kationd's whole D-Bus interface,
  `com.hleroy.Kation.Drive1`. Any bump is checked against
  `daemon/src/service/dbusServer.ts` and the other importers for signature,
  marshalling and bus-connection changes. CI does not run kationd on a real bus (see
  below), so any behavioral change there is REVIEW NEEDED.
- **`@types/bun` and the Bun runtime.** The runtime is pinned in `daemon/.bun-version`
  (used by CI through `setup-bun`), which Dependabot does not update; `engines.bun`
  gives the floor. An `@types/bun` whose minor is ahead of `.bun-version` is REVIEW
  NEEDED: the types may describe APIs the pinned runtime lacks, and `tsc` would not
  notice. Suggest bumping `.bun-version` in a separate PR.
- **`typescript`.** The `kationd-types` ctest test type-checks kationd **and** the SDK
  sources from the submodule (upstream builds with `^5.x`), so CI is real evidence; a
  major is still a Step 2c case. Watch for deprecated `tsconfig.json` options (a
  deprecation already forced dropping `baseUrl`).
- **`@biomejs/biome`.** The `Lint (pre-commit)` job runs `biome check --write`; if the
  new version formats or lints differently, the job fails because the hook changed
  files. The fix is a reformat, which `CLAUDE.md` wants in a PR of its own (so its
  squash commit can go in `.git-blame-ignore-revs`): REVIEW NEEDED, naming the files
  and rules. `daemon/biome.jsonc` takes its `$schema` from `node_modules`, so there is
  no version string to sync; a config migration (`biome migrate`) is a code change,
  so REVIEW NEEDED.
- **github-actions.** Actions are pinned to full commit SHAs with a `# vX.Y.Z` comment.
  Check that the new SHA is the commit the upstream tag points to, that the comment
  moved with it, and that **every** occurrence of the action across `ci.yml`,
  `pr-title.yml`, `packages.yml` and `release.yml` moved together. A PR that replaces a
  SHA with a tag, or changes anything in a workflow beyond `uses:` lines, is DO NOT
  MERGE. A major can change defaults (Node runtime, inputs, permissions): check each
  usage's `with:` inputs against the new version.
- **Actions CI cannot see are always REVIEW NEEDED**, however small the bump: any action
  used only in `release.yml` or `packages.yml` (today `actions/attest-build-provenance`
  and `actions/download-artifact`), and `amannn/action-semantic-pull-request`, whose step
  `pr-title.yml` skips for Dependabot PRs, so its own bump never runs. Work the list out
  from the workflows at run time rather than trusting this one. `release.yml` signs the
  RPM with a private key and attests build provenance, and a breakage only shows when a
  version is tagged; say which workflow is affected and that the maintainer should run
  `packages.yml` by hand (it has `workflow_dispatch`) or check the next release.

### Ask what CI can actually see

Green checks are evidence only about code the suite really runs. The `Build and test`
job builds everything on Fedora and runs the whole ctest suite: the kationd unit tests
(`bun test`), the type check, the compiled `kationd` starting up (`kationd-runs`,
`kationd-isolated`), the `proton-copy` check, and the KDE tests. It does **not**:

- call Proton's API: there is no account in CI, and the real-account end-to-end run
  (`docs/e2e-test-plan.md`) is manual. Network, crypto and SDK behavior (`ky`,
  `@noble/hashes`, `@protontech/*`) is not exercised against the real service;
- run kationd on a real D-Bus session with the KDE side: the KDE tests talk to a fake
  kationd (`kde/autotests/fakekationd.h`), and `dbusContract.test.ts` checks the
  interface XML against the server code without connecting to a bus. `dbus-next`
  behavior is not exercised;
- run `packages.yml` or `release.yml`.

For a dependency CI cannot reach, a green run is not weak evidence, it is **no**
evidence, and the burden falls entirely on Step 2. Guard against the comfortable
intuition: a dependency the tests cannot touch needs **stronger** independent evidence
than one they really run.

## Step 4: classify

**SAFE TO MERGE**: all of

- every check present and green, mergeable and clean;
- every **major** constituent passed Step 2c in full;
- every **fresh** constituent passed Step 2b in full;
- Step 2 completed for each, the changelog actually read or, where none exists, the
  artifact diffed;
- every lockfile change accounted for, and every new supplier researched;
- no breaking, deprecated or changed-default behavior that Kation exercises;
- no invariant above touched, and nothing on the "CI cannot see" list.

**REVIEW NEEDED**: anything unresolved rather than known-bad: a major that did not
pass every Step 2c check, a fresh release Step 2b could not fully verify, a bump that
needs a code change or reformat on the branch, a release whose content neither notes
nor artifact could establish, a behavioral change whose impact you cannot rule out, an
action CI cannot see, a failing but plausibly flaky check, or an invariant that needs a
human eye.

**DO NOT MERGE**: known-bad: a breaking change Kation demonstrably uses, a change to
the SDK, the copied CLI code or `@protontech/crypto`, an SDK-mirrored package outside
upstream's range, an override undercut, a workflow change beyond `uses:` lines, a
security regression or suspicious release, a check failing because the new version
itself is broken (not merely because Kation needs adapting), or a conflicted branch.

## Step 5: mark

Every triaged PR gets exactly one label (`safe-to-merge`, `review-needed` or
`do-not-merge`) plus one comment. Remove either of the other two if present. With
`mcp__github__issue_write`, pass the PR's existing labels back alongside the verdict
label, minus the other two verdicts.

Pass the comment body inline (a `gh` heredoc, or the MCP tool's `body` argument),
never through a file in the checkout. Write it in English, and carry the reasoning,
not just the verdict:

```markdown
## <VERDICT>

**Checks:** Lint ✅ · Build and test ✅ · pr-title ✅ (skipped for Dependabot) · GitGuardian ✅ · mergeable/clean
**Release age:** <each new version's publication date; for a fresh one, "FRESH — N days, security update for GHSA-…" plus the Step 2b results>

| Package | Old → New | Type | Shipped? | Finding |
|---|---|---|---|---|
| typescript | 5.9.3 → 5.10.1 | minor | dev | <what the release notes say, and whether Kation uses it> |

**Lockfile:** <every changed entry accounted for; new suppliers, if any; overrides still hold>
**Impact on Kation:** <what was grepped for, what was found or absent>
**What CI can see:** <whether the green run is real evidence for this dependency>
**Invariants:** <which were considered, and why they are or are not affected>
**Verdict rationale:** <one short paragraph>

<sub>Automated weekly Dependabot triage.</sub>
```

State findings honestly: if a changelog was thin, say so rather than implying research
that did not happen.

## Step 6: merge the safe ones

Only PRs labeled `safe-to-merge` in this run, squash-merged with the call from the
tooling table.

The PR title becomes the commit on `main`, and `pr-title.yml` skips its check for
Dependabot, so **check the title yourself**: a type from `.github/workflows/pr-title.yml`
(Dependabot uses `chore`), an optional scope (`deps`, `deps-dev`), then a description
starting with a lowercase letter. If it does not conform, downgrade to REVIEW NEEDED
instead of merging; do not rename a Dependabot PR.

Merge one at a time and re-check the next PR's mergeability afterwards: an earlier
merge can put a later PR behind `main` (two PRs both rewriting `daemon/bun.lock` will
conflict). A PR that goes stale mid-run is REVIEW NEEDED, not a failure; Dependabot
rebases it for the next run.

## Step 7: report

Send a push notification summarizing the run (if the push-notification tool is
unavailable, print the same line as the first line of the report instead):

> Dependabot triage: N merged, N need review, N blocked (M PRs total)

Then print a short table of every PR with its verdict and a one-line reason, and list
any missing labels or failed writes. If there was nothing to merge, say that plainly.
