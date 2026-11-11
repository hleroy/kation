#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Kation contributors
# SPDX-License-Identifier: GPL-2.0-or-later

# Tests the PAM step of disable-gnome-keyring.sh on fixture files, without root
# and without touching the session: PAM_DIR is a temporary folder, and
# GNOME_KEYRING_PAM_ONLY limits the run to the PAM step. Run by ctest.

set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/disable-gnome-keyring.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
FAILURES=0

fail() {
    echo "FAIL: $*" >&2
    FAILURES=$((FAILURES + 1))
}

# Runs the script on one fixture folder; sets OUTPUT and STATUS.
run() {
    local case_dir=$1
    shift
    STATUS=0
    # env -i: no session bus or runtime folder, so nothing outside the fixture can be reached.
    OUTPUT=$(env -i PATH=/usr/bin:/bin HOME="$case_dir/home" XDG_CONFIG_HOME="$case_dir/home/.config" \
        XDG_DATA_HOME="$case_dir/home/.local/share" PAM_DIR="$case_dir/pam.d" PAM_VENDOR_DIRS="$case_dir/vendor" \
        GNOME_KEYRING_PAM_ONLY=1 bash "$SCRIPT" --force "$@" 2>&1) || STATUS=$?
}

# Creates a fixture folder with one PAM file; prints the folder.
fixture() {
    local file=$2 content=$3 dir="$WORK/$1"
    mkdir -p "$dir/pam.d" "$dir/home"
    printf '%s' "$content" >"$dir/pam.d/$file"
    cp "$dir/pam.d/$file" "$dir/original-$file"
    echo "$dir"
}

disabled() { grep -q "^#gnome-keyring-disabled# $2" "$1"; }

# 1. A stock Debian-style file: both lines are commented out, and --undo restores it.
dir=$(fixture debian login '# The PAM configuration file for login
auth       requisite  pam_nologin.so
@include common-auth
auth       optional   pam_gnome_keyring.so
@include common-account
session    optional   pam_gnome_keyring.so auto_start
')
run "$dir"
[[ $STATUS -eq 0 ]] || fail "debian: exit status $STATUS"
disabled "$dir/pam.d/login" 'auth       optional   pam_gnome_keyring.so' || fail "debian: auth line not disabled"
disabled "$dir/pam.d/login" 'session    optional   pam_gnome_keyring.so' || fail "debian: session line not disabled"
[[ $OUTPUT == *"disabled pam_gnome_keyring in $dir/pam.d/login"* ]] || fail "debian: message changed: $OUTPUT"
run "$dir" --undo
[[ $STATUS -eq 0 ]] || fail "debian undo: exit status $STATUS"
cmp -s "$dir/pam.d/login" "$dir/original-login" || fail "debian undo: not restored byte for byte"

# 2. A jump over the keyring line: the file is left alone, with a warning and a non-zero status.
jump='auth [success=1 default=ignore] pam_unix.so nullok
auth optional pam_gnome_keyring.so
auth requisite pam_deny.so
auth required pam_permit.so
'
dir=$(fixture jump common-auth "$jump")
run "$dir"
[[ $STATUS -ne 0 ]] || fail "jump: exit status 0"
cmp -s "$dir/pam.d/common-auth" "$dir/original-common-auth" || fail "jump: file changed"
[[ ! -e "$dir/pam.d/common-auth.bak" ]] || fail "jump: backup made of a file left alone"
[[ $OUTPUT == *"$dir/pam.d/common-auth"*"line 2"*"line 1"* ]] || fail "jump: no warning naming the file and lines: $OUTPUT"

# 3. The same jump, with the keyring line of another type: commented out.
dir=$(fixture other-type common-auth 'auth [success=1 default=ignore] pam_unix.so nullok
auth requisite pam_deny.so
auth required pam_permit.so
session optional pam_gnome_keyring.so auto_start
')
run "$dir"
[[ $STATUS -eq 0 ]] || fail "other type: exit status $STATUS: $OUTPUT"
disabled "$dir/pam.d/common-auth" 'session optional pam_gnome_keyring.so' || fail "other type: session line not disabled"

# 4. A jump of 1 that lands before the keyring line: commented out.
dir=$(fixture before common-auth 'auth [success=1 default=ignore] pam_unix.so nullok
auth requisite pam_deny.so
auth optional pam_gnome_keyring.so
')
run "$dir"
[[ $STATUS -eq 0 ]] || fail "lands before: exit status $STATUS: $OUTPUT"
disabled "$dir/pam.d/common-auth" 'auth optional pam_gnome_keyring.so' || fail "lands before: auth line not disabled"

# 5. A file with a jump next to one without: the other file is still handled.
dir=$(fixture mixed common-auth "$jump")
printf 'auth optional pam_gnome_keyring.so\n' >"$dir/pam.d/login"
run "$dir"
[[ $STATUS -ne 0 ]] || fail "mixed: exit status 0"
cmp -s "$dir/pam.d/common-auth" "$dir/original-common-auth" || fail "mixed: file with the jump changed"
disabled "$dir/pam.d/login" 'auth optional pam_gnome_keyring.so' || fail "mixed: the other file was not handled"

if [[ $FAILURES -gt 0 ]]; then
    echo "$FAILURES check(s) failed" >&2
    exit 1
fi
echo "All checks passed"
