// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Computes the version strings Kation reports to Proton.
 *
 * Proton requires third-party apps to identify themselves honestly with
 * `x-pm-appversion: external-drive-{name}@{semver}-{channel}+{suffix}`.
 * See the "Usage Guidelines for Personal Projects" in the SDK README.
 */
import path from 'node:path';

const DAEMON_DIR = path.resolve(import.meta.dir, '..');
const REPO_DIR = path.resolve(DAEMON_DIR, '..');
const SDK_DIR = path.join(REPO_DIR, 'third_party', 'proton-drive-sdk');

/** Project identifier in the app version header: lowercase letters and underscores only. */
export const APP_VERSION_NAME = 'kation';
/** Release channel reported to Proton. */
export const APP_CHANNEL: 'alpha' | 'beta' | 'stable' = 'beta';

export type Versions = {
    /** Value of the `x-pm-appversion` header, e.g. `external-drive-kation@0.1.0-beta+abc1234`. */
    appVersion: string;
    /** Value of the `x-pm-drive-sdk-version` header, e.g. `js@0.22.2+df3a717b`. */
    sdkVersion: string;
};

export async function computeVersions(): Promise<Versions> {
    const packageJson = await Bun.file(path.join(DAEMON_DIR, 'package.json')).json();
    const semver: string = process.env.KATION_VERSION?.trim() || packageJson.version;
    const commit = process.env.KATION_COMMIT?.trim() || git(REPO_DIR, ['rev-parse', '--short', 'HEAD']) || 'unknown';
    return {
        appVersion: formatAppVersion(semver, APP_CHANNEL, commit),
        sdkVersion: process.env.KATION_SDK_VERSION?.trim() || (await sdkVersionFromCheckout()),
    };
}

export function formatAppVersion(semver: string, channel: string, suffix?: string): string {
    return `external-drive-${APP_VERSION_NAME}@${semver}-${channel}${suffix ? `+${suffix}` : ''}`;
}

/** Reads `js/v0.22.2` from the first release heading of the SDK changelog. */
export function parseSdkChangelog(changelog: string): string | undefined {
    return changelog.match(/^## js\/v(\d+\.\d+\.\d+)\b/m)?.[1];
}

async function sdkVersionFromCheckout(): Promise<string> {
    // The changelog's latest release plus the submodule commit. Git tags are
    // not used: shallow or partial checkouts would give a wrong version.
    const changelog = Bun.file(path.join(SDK_DIR, 'client', 'js', 'CHANGELOG.md'));
    const release = (await changelog.exists()) ? parseSdkChangelog(await changelog.text()) : undefined;
    const commit = git(SDK_DIR, ['rev-parse', '--short=8', 'HEAD']);
    if (!release || !commit) {
        throw new Error('Cannot determine the Proton SDK version. Run "git submodule update --init" or set KATION_SDK_VERSION.');
    }
    return `js@${release}+${commit}`;
}

function git(cwd: string, args: string[]): string | undefined {
    const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' });
    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}
