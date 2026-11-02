// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';

import { formatAppVersion, parseSdkChangelog } from '../scripts/versions';

// Pattern from the Proton Drive SDK README: external-drive-{name}@{semver}-{channel}+{suffix}
const PROTON_APP_VERSION_PATTERN = /^external-drive-[a-z_]+@\d+\.\d+\.\d+(-(stable|beta|alpha))?(\+[0-9A-Za-z.-]+)?$/;

describe('formatAppVersion', () => {
    it('follows the shape Proton requires for third-party apps', () => {
        expect(formatAppVersion('0.1.0', 'alpha', 'abc1234')).toBe('external-drive-kation@0.1.0-alpha+abc1234');
        expect(formatAppVersion('1.2.3', 'stable')).toBe('external-drive-kation@1.2.3-stable');
        expect(formatAppVersion('0.1.0', 'alpha', 'abc1234')).toMatch(PROTON_APP_VERSION_PATTERN);
    });
});

describe('parseSdkChangelog', () => {
    it('reads the latest release heading', () => {
        const changelog = '# Changelog\n\n## js/v0.22.2 (2026-10-02)\n\n### Bug Fixes\n\n## js/v0.22.1 (2026-10-02)\n';
        expect(parseSdkChangelog(changelog)).toBe('0.22.2');
    });

    it('returns undefined without a release heading', () => {
        expect(parseSdkChangelog('# Changelog\n')).toBeUndefined();
    });
});
