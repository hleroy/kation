# Kation

Unofficial Proton Drive client for KDE Plasma: `kationd` (TypeScript on Bun,
`daemon/`) owns everything Proton-related and serves it over D-Bus
(`dbus/com.hleroy.Kation.Drive1.xml`); the KDE side (C++, Qt 6, KF6, `kde/`)
talks only to kationd. See README.md (users), DEVNOTES.md (developers) and
ROADMAP.md.

## Commands

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX=/usr
cmake --build build
ctest --test-dir build --output-on-failure     # the whole suite, about 2.5 minutes
(cd daemon && bun test && bun x tsc --noEmit -p .)   # kationd only, seconds
pre-commit install                             # once per clone: pre-commit, commit-msg, pre-push
pre-commit run --all-files                     # every lint and format hook
po/update.sh                                   # after changing user-visible strings
./build-package.sh                             # .deb, .rpm or Arch package into dist/
```

**Run the full ctest suite before every commit of a code change**, and confirm it
passes. pre-commit runs linters and formatters only (and `bun test` before a push),
so a green pre-commit run is not a passing suite. Docs-only changes are exempt.

`sudo` steps (`sudo cmake --install build`, `sudo apt install ./dist/…`) are run by
the user; ask them to type `! <command>`.

## Rules

- **Never reformat `daemon/src/proton/`** (copied from the Proton Drive CLI, MIT) or
  `third_party/`. Biome excludes `src/proton/`; keep it that way so upstream merges
  stay simple.
- **D-Bus contract:** the interface XML documents every method, signal and map key.
  Change it together with `daemon/src/service/dbusServer.ts` and
  `daemon/test/dbusContract.test.ts`.
- **User-visible text:**
  - Every string the KDE side shows goes through `i18n()` and friends.
  - kationd sends codes (`reason`, `problemCode`) plus English text for logs and the
    CLI; the KDE side words the codes (`kde/dbus/kationtexts.cpp`). Do not show a
    new kationd sentence as-is: add a code.
  - After changing strings, run `po/update.sh` and translate the new entries in
    `po/fr/kation.po` in the same change. ctest's `po-check` fails otherwise.
  - A new translatable key in a `.desktop`, `.notifyrc` or plugin `.json` file
    gets its `[fr]` variant by hand.
  - French: KDE's French terms (Configuration du système, Corbeille, boîte à
    miniatures), « guillemets », a non-breaking space before `: ; ? !`.
- **Packaging:** whatever ships must be installed by a CMake `install()` rule; CPack
  packages exactly that (`cmake/KationPackaging.cmake`), and so does the Arch
  `packaging/arch/PKGBUILD.in`. Never strip `kationd`: `bun build --compile`
  appends the program to the executable. A runtime library loaded with dlopen
  (like libsecret) must be added to `CPACK_DEBIAN_PACKAGE_DEPENDS`,
  `CPACK_RPM_PACKAGE_REQUIRES` and the PKGBUILD's `depends`.
- **Versions:** `project(VERSION)` in `CMakeLists.txt` and `daemon/package.json`
  must match (CMake checks). The SDK submodule stays pinned to a release tag.
- **Licensing:** every new file gets SPDX headers, or an entry in `REUSE.toml` when it
  cannot carry a comment. `pre-commit` runs `reuse lint`.

## Git and pull requests

[Conventional Commits](https://www.conventionalcommits.org/), checked by the
commit-msg hook and, for PR titles, by `.github/workflows/pr-title.yml`:

- `<type>[optional scope]: <description>`, description lowercase and imperative.
- Types: `feat fix refactor chore docs test style perf ci build revert`.
- Scopes when useful: `daemon`, `kde`, `kio`, `tray`, `dolphin`, `kcm`, `i18n`, `deb`, `ci`.

Work on a branch named `<type>/<short-description>`, open a PR, and squash-merge it
(the only merge method enabled): the PR title becomes the commit on `main`. A pure
reformat goes in a PR of its own, so that its squash commit can be listed in
`.git-blame-ignore-revs`.

## Changelog

Add a line to `[Unreleased]` in `CHANGELOG.md` for every user-visible change. One
line per entry: what changed, plus a short "why" only when it is not obvious. No
paragraphs, no narrating the investigation.

To release: bump `project(VERSION)` and `daemon/package.json`, rename `[Unreleased]`
to `[x.y.z] - YYYY-MM-DD` with a compare link, merge that, then tag the merged commit
on `main` `vx.y.z` and push the tag: the Release workflow checks the tag and version,
builds the packages and publishes the GitHub release. To redo a release, delete it and
its tag first (`gh release delete vx.y.z --cleanup-tag`): the workflow fails when the
release already exists.

## Code comments

- Only keep or add a comment when it explains *why* non-obvious code exists (a
  workaround, a tricky invariant, a spec reference). If it restates *what* the code
  does, omit it.
- Never narrate edits or history (`// removed X`, `// new`, `// was previously…`):
  that belongs in the commit message.
- Keep comments short, one or two lines. The full rationale belongs in the commit
  message, the PR, or `docs/`.

## Review before completion

After implementing a plan, once ctest and `pre-commit run --all-files` pass, review
the full diff (`git diff main...HEAD` plus uncommitted changes) in a fresh-context
subagent with the `code-review` skill. Give it the plan's acceptance criteria and
this file.

- Fix high and critical findings. Fix medium ones only with a concrete failure
  scenario. List low ones in the summary.
- At most two passes; a second only if the first found high or critical issues.
- Re-run ctest after any fix.

## End-to-end tests

`docs/e2e-test-plan.md` drives a run against a real Proton **test** account
(`daemon/e2e/realAccount.ts`). Always confirm the account with the tester first.
