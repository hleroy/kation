// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { computeVersions } from '../scripts/versions';

/** Reverse-DNS application ID, also used for the keyring entry and the D-Bus name. */
export const APP_ID = 'com.hleroy.Kation';
/** Directory name under the XDG cache/data/state folders. */
export const APP_DIR_NAME = 'kation';
/** Prefix of the per-installation client UID sent to Proton. */
export const CLIENT_UID_PREFIX = 'kation-linux';

/** Shown wherever the user is asked to sign in, as Proton's guidelines require. */
export const THIRD_PARTY_NOTICE = 'This is a third-party application not officially supported by Proton.';

// Replaced at build time by scripts/build.ts. When running from source
// (`bun run dev`) they are undefined and computed from git instead.
declare const KATION_APP_VERSION: string | undefined;
declare const KATION_SDK_VERSION: string | undefined;

export async function getVersions(): Promise<{ appVersion: string; sdkVersion: string }> {
    if (typeof KATION_APP_VERSION === 'string' && typeof KATION_SDK_VERSION === 'string') {
        return { appVersion: KATION_APP_VERSION, sdkVersion: KATION_SDK_VERSION };
    }
    return computeVersions();
}
