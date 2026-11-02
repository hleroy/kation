#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

# Updates the translation template po/kation.pot from the sources (through
# Messages.sh) and merges it into each po/<lang>/kation.po.
#
#   po/update.sh           update po/
#   po/update.sh --check   change nothing; fail if po/ is out of date, if a
#                          translation is incomplete or fuzzy, or if one does
#                          not compile (run by ctest as "po-check")

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

check=false
case "${1:-}" in
    --check) check=true ;;
    "") ;;
    *)
        echo "Usage: $0 [--check]" >&2
        exit 2
        ;;
esac

version=$(sed -n 's/^project(kation VERSION \([0-9.]*\).*/\1/p' CMakeLists.txt)

# The KI18n keywords, as KDE's scripty passes them. Locations are file names
# only, so the files do not change each time a line moves.
XGETTEXT="xgettext --from-code=UTF-8 -C --kde --add-location=file --sort-by-file
    --package-name=kation --package-version=$version
    --msgid-bugs-address=https://github.com/hleroy/kation/issues
    -ci18n -ki18n:1 -ki18nc:1c,2 -ki18np:1,2 -ki18ncp:1c,2,3
    -kki18n:1 -kki18nc:1c,2 -kki18np:1,2 -kki18ncp:1c,2,3
    -kxi18n:1 -kxi18nc:1c,2 -kxi18np:1,2 -kxi18ncp:1c,2,3
    -kkxi18n:1 -kkxi18nc:1c,2 -kkxi18np:1,2 -kkxi18ncp:1c,2,3
    -kkli18n:1 -kkli18nc:1c,2 -kkli18np:1,2 -kkli18ncp:1c,2,3
    -kklxi18n:1 -kklxi18nc:1c,2 -kklxi18np:1,2 -kklxi18ncp:1c,2,3
    -kI18N_NOOP:1 -kI18NC_NOOP:1c,2"
export XGETTEXT

if ! $check; then
    podir="$ROOT/po" bash ./Messages.sh
    for po in po/*/kation.po; do
        msgmerge --quiet --update --backup=none --add-location=file "$po" po/kation.pot
    done
    echo "Updated po/kation.pot and $(find po -name kation.po | wc -l) translation(s)."
    exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
podir="$tmp" bash ./Messages.sh

status=0
# Same messages in the committed template and the sources, both ways.
if ! msgcmp --use-untranslated "$tmp/kation.pot" po/kation.pot >/dev/null 2>&1 ||
    ! msgcmp --use-untranslated po/kation.pot "$tmp/kation.pot" >/dev/null 2>&1; then
    echo "po/kation.pot is out of date: run po/update.sh" >&2
    status=1
fi
for po in po/*/kation.po; do
    if ! msgfmt --check -o /dev/null "$po"; then
        echo "$po does not compile" >&2
        status=1
    fi
    # Every message translated, and not fuzzy.
    if ! msgcmp "$po" "$tmp/kation.pot" >/dev/null 2>&1; then
        echo "$po is missing translations: run po/update.sh, then translate" >&2
        status=1
    fi
    if [ -n "$(msgattrib --only-fuzzy --no-obsolete "$po")" ]; then
        echo "$po has fuzzy translations" >&2
        status=1
    fi
done
exit $status
