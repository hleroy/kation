// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Builds the standalone `kationd` executable (Bun embedded).
 *
 * Usage: bun ./scripts/build.ts [--outfile path] [--target bun-linux-x64]
 */
import path from 'node:path';
import { parseArgs } from 'node:util';

import { computeVersions } from './versions';

const DAEMON_DIR = path.resolve(import.meta.dir, '..');

const { values } = parseArgs({
    options: {
        outfile: { type: 'string', default: path.join(DAEMON_DIR, 'dist', 'kationd') },
        target: { type: 'string', default: 'bun' },
    },
});

const { appVersion, sdkVersion } = await computeVersions();
console.log(`Building kationd: app=${appVersion} sdk=${sdkVersion}`);

const proc = Bun.spawn(
    [
        process.execPath,
        'build',
        '--compile',
        '--bytecode',
        `--target=${values.target}`,
        '--format=esm',
        '--minify',
        '--sourcemap=inline',
        // Optional native modules of dbus-next. It falls back to plain sockets
        // without usocket, and only needs x11 when no session bus address is set.
        '--external=usocket',
        '--external=x11',
        '--define',
        `KATION_APP_VERSION=${JSON.stringify(appVersion)}`,
        '--define',
        `KATION_SDK_VERSION=${JSON.stringify(sdkVersion)}`,
        path.join(DAEMON_DIR, 'src', 'main.ts'),
        `--outfile=${values.outfile}`,
    ],
    { cwd: DAEMON_DIR, stdio: ['inherit', 'inherit', 'inherit'], env: { ...process.env, NODE_ENV: 'production' } },
);
process.exit(await proc.exited);
