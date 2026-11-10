// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Builds the standalone `kationd` executable (Bun embedded).
 *
 * Usage: bun ./scripts/build.ts [--outfile path] [--target bun-linux-x64]
 */
import path from 'node:path';
import { parseArgs } from 'node:util';

import type { BunPlugin } from 'bun';

import { computeVersions, type Versions } from './versions';

const DAEMON_DIR = path.resolve(import.meta.dir, '..');

// Optional native modules of dbus-next, never shipped. Left out of the bundle, they would be
// looked up at run time in node_modules of the directory kationd is started from, and run.
const ABSENT_MODULES: Record<string, string> = {
    usocket: 'throw new Error("abstract D-Bus socket addresses are not supported");',
    x11: 'module.exports = null;',
};

/** Keeps kationd from loading code from disk when it runs: see test/build.test.ts. */
const nothingFromDisk: BunPlugin = {
    name: 'nothing-from-disk',
    setup(build) {
        const absent = new RegExp(`^(${Object.keys(ABSENT_MODULES).join('|')})$`);
        build.onResolve({ filter: absent }, ({ path: name }) => ({ path: name, namespace: 'absent' }));
        build.onLoad({ filter: /.*/, namespace: 'absent' }, ({ path: name }) => ({ contents: ABSENT_MODULES[name]!, loader: 'js' }));

        // openpgp keeps a `require` for Node's own modules, and also asks it for eckey-utils,
        // which is not installed: that one would be looked up on disk like the modules above.
        build.onLoad({ filter: /[\\/]openpgp[\\/]dist[\\/]node[\\/]openpgp\.mjs$/ }, async ({ path: file }) => ({
            contents: (await Bun.file(file).text()).replaceAll(
                'createRequire(import.meta.url)',
                '((name) => process.getBuiltinModule(name))',
            ),
            loader: 'js',
        }));
    },
};

/** How kationd is bundled. */
export function bundleConfig(versions: Versions): Bun.BuildConfig {
    return {
        entrypoints: [path.join(DAEMON_DIR, 'src', 'main.ts')],
        target: 'bun',
        format: 'esm',
        plugins: [nothingFromDisk],
        define: {
            'process.env.NODE_ENV': JSON.stringify('production'),
            KATION_APP_VERSION: JSON.stringify(versions.appVersion),
            KATION_SDK_VERSION: JSON.stringify(versions.sdkVersion),
        },
    };
}

if (import.meta.main) {
    const { values } = parseArgs({
        options: {
            outfile: { type: 'string', default: path.join(DAEMON_DIR, 'dist', 'kationd') },
            target: { type: 'string', default: 'bun' },
        },
    });
    // Source paths in the executable, and a relative --outfile, are relative to the working directory.
    process.chdir(DAEMON_DIR);

    const versions = await computeVersions();
    console.log(`Building kationd: app=${versions.appVersion} sdk=${versions.sdkVersion}`);

    // Bun.build throws when the build fails, which ends this script with an error.
    const result = await Bun.build({
        ...bundleConfig(versions),
        compile: {
            outfile: values.outfile,
            ...(values.target === 'bun' ? {} : { target: values.target as Bun.Build.CompileTarget }),
            // By default the executable loads bunfig.toml (which can preload scripts) and .env
            // files from the directory it is started from. scripts/checkIsolation.ts checks this.
            autoloadBunfig: false,
            autoloadDotenv: false,
            autoloadTsconfig: false,
            autoloadPackageJson: false,
        },
        bytecode: true,
        minify: true,
        sourcemap: 'inline',
    });
    for (const log of result.logs) {
        console.log(log);
    }
}
