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
# Not cmp: diffutils is not in every base image.
same() { [[ $(sha256sum <"$1") == $(sha256sum <"$2") ]]; }

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
same "$dir/pam.d/login" "$dir/original-login" || fail "debian undo: not restored byte for byte"

# 2. A jump over the keyring line: the file is left alone, with a warning and a non-zero status.
jump='auth [success=1 default=ignore] pam_unix.so nullok
auth optional pam_gnome_keyring.so
auth requisite pam_deny.so
auth required pam_permit.so
'
dir=$(fixture jump common-auth "$jump")
run "$dir"
[[ $STATUS -eq 3 ]] || fail "jump: exit status $STATUS"
same "$dir/pam.d/common-auth" "$dir/original-common-auth" || fail "jump: file changed"
[[ ! -e "$dir/pam.d/common-auth.bak" ]] || fail "jump: backup made of a file left alone"
[[ $OUTPUT == *"$dir/pam.d/common-auth, line 2"*"jump on line 1"*"success=1"* ]] || fail "jump: no warning naming the file and lines: $OUTPUT"
[[ $OUTPUT != *"awk:"* ]] || fail "jump: awk printed a warning: $OUTPUT"

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
[[ $STATUS -eq 3 ]] || fail "mixed: exit status $STATUS"
same "$dir/pam.d/common-auth" "$dir/original-common-auth" || fail "mixed: file with the jump changed"
disabled "$dir/pam.d/login" 'auth optional pam_gnome_keyring.so' || fail "mixed: the other file was not handled"

# 6. Two jumps over the keyring line (an SSSD-style stack): both are reported.
dir=$(fixture two-jumps common-auth 'auth [success=3 default=ignore] pam_unix.so nullok
auth [success=2 default=ignore] pam_sss.so use_first_pass
auth optional pam_gnome_keyring.so
auth requisite pam_deny.so
auth required pam_permit.so
')
run "$dir"
[[ $STATUS -eq 3 ]] || fail "two jumps: exit status $STATUS"
same "$dir/pam.d/common-auth" "$dir/original-common-auth" || fail "two jumps: file changed"
[[ $OUTPUT == *"jump on line 1"*"jump on line 2"* ]] || fail "two jumps: both jumps not reported: $OUTPUT"

# 7. Forms libpam accepts in the jump: "-", upper case, spaces around "=", a continued line.
dir=$(fixture syntax common-auth '-AUTH [default = ignore \
    success = 1] pam_unix.so nullok
auth optional /usr/lib/security/pam_gnome_keyring.so debug
auth requisite pam_deny.so
')
run "$dir"
[[ $STATUS -eq 3 ]] || fail "syntax: exit status $STATUS: $OUTPUT"
same "$dir/pam.d/common-auth" "$dir/original-common-auth" || fail "syntax: file changed"

# 8. A keyring line with a jump of its own: left alone (with one item in brackets, the
# script's pattern matches it), or never matched at all (several items).
dir=$(fixture own-jump common-auth 'auth [success=1] pam_gnome_keyring.so
auth requisite pam_deny.so
auth required pam_permit.so
')
run "$dir"
[[ $STATUS -eq 3 ]] || fail "own jump: exit status $STATUS"
same "$dir/pam.d/common-auth" "$dir/original-common-auth" || fail "own jump: file changed"
dir=$(fixture own-jump-items common-auth 'auth [success=1 default=ignore] pam_gnome_keyring.so
auth requisite pam_deny.so
auth required pam_permit.so
')
run "$dir"
same "$dir/pam.d/common-auth" "$dir/original-common-auth" || fail "own jump, several items: file changed"

# 9. A keyring line an earlier version commented out inside a jump: a warning pointing to --undo.
dir=$(fixture earlier common-auth 'auth [success=2 default=ignore] pam_unix.so nullok
#gnome-keyring-disabled# auth optional pam_gnome_keyring.so
auth requisite pam_deny.so
auth required pam_permit.so
')
run "$dir"
[[ $STATUS -eq 3 ]] || fail "earlier: exit status $STATUS"
[[ $OUTPUT == *"earlier version"*"lower success=2 in line 1"*'with "# "'* ]] || fail "earlier: no warning: $OUTPUT"

# 10. A vendor file with a jump: no copy is made in PAM_DIR.
dir=$(fixture vendor unused '')
mkdir -p "$dir/vendor"
printf '%s' "$jump" >"$dir/vendor/common-auth"
run "$dir"
[[ $STATUS -eq 3 ]] || fail "vendor: exit status $STATUS"
[[ ! -e "$dir/pam.d/common-auth" ]] || fail "vendor: copied to PAM_DIR"
[[ $OUTPUT == *"vendor file"* ]] || fail "vendor: no note about vendor files: $OUTPUT"

# 11. The hand fix as the script words it, for a "-auth" line: no warning when run again,
# and --undo leaves the commented line (and so the lowered jump) alone.
dir=$(fixture hand-fixed common-auth 'auth [success=1 default=ignore] pam_unix.so nullok
# -auth optional pam_gnome_keyring.so
auth requisite pam_deny.so
auth required pam_permit.so
')
run "$dir"
[[ $STATUS -eq 0 ]] || fail "hand fixed: exit status $STATUS: $OUTPUT"
run "$dir" --undo
same "$dir/pam.d/common-auth" "$dir/original-common-auth" || fail "hand fixed: --undo changed the file"

# 12. A "#-auth" line is not taken for one this script commented out.
dir=$(fixture legacy common-auth 'auth [success=1 default=ignore] pam_unix.so nullok
#-auth optional pam_gnome_keyring.so
auth requisite pam_deny.so
auth required pam_permit.so
')
run "$dir"
[[ $STATUS -eq 0 ]] || fail "legacy: exit status $STATUS: $OUTPUT"
same "$dir/pam.d/common-auth" "$dir/original-common-auth" || fail "legacy: file changed"

# 13. A backslash in a trailing comment does not continue the line.
dir=$(fixture comment common-auth 'auth [success=2 default=ignore] pam_unix.so nullok # see bug \
auth optional pam_gnome_keyring.so
auth requisite pam_deny.so
auth required pam_permit.so
')
run "$dir"
[[ $STATUS -eq 3 ]] || fail "comment: exit status $STATUS: $OUTPUT"
same "$dir/pam.d/common-auth" "$dir/original-common-auth" || fail "comment: file changed"

if [[ $FAILURES -gt 0 ]]; then
    echo "$FAILURES check(s) failed" >&2
    exit 1
fi
echo "All checks passed"
