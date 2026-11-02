// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Logger } from '@protontech/drive-sdk';

import { DriveService } from '../src/service/driveService';
import { FakeDrive, type FakeDriveOptions } from '../src/service/fakeDrive';
import type { DriveSdk } from '../src/service/sdk';
import { DriveTree } from '../src/service/tree';

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Wraps an SDK and counts folder listings, the calls the tree cache should avoid. */
export function countingSdk(sdk: DriveSdk): { sdk: DriveSdk; listings: () => number } {
    let listings = 0;
    return {
        sdk: {
            ...sdk,
            iterateFolderChildrenNodeUids: (...args) => {
                listings++;
                return sdk.iterateFolderChildrenNodeUids(...args);
            },
        },
        listings: () => listings,
    };
}

export function setup(options: FakeDriveOptions = {}) {
    const fake = new FakeDrive(options);
    const counting = countingSdk(fake.sdk);
    const tree = new DriveTree(counting.sdk, silentLogger);
    const drive = new DriveService(counting.sdk, tree, silentLogger);
    return { fake, tree, drive, listings: counting.listings };
}

export async function tempDir(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), 'kation-test-'));
}
