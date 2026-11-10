// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';
import { isBuiltin } from 'node:module';

import { bundleConfig } from '../scripts/build';

/**
 * What a bundle can still load when it runs: `modules` are static imports and require() or
 * import() of a literal name; `requires` are the arguments of createRequire(), whose result
 * loads any name from disk, starting from that location.
 */
async function runtimeLoads(config: Bun.BuildConfig): Promise<{ modules: string[]; requires: string[] }> {
    const result = await Bun.build(config);
    expect(result.success).toBe(true);
    const modules = new Set<string>();
    const requires = new Set<string>();
    for (const output of result.outputs) {
        const code = await output.text();
        for (const { path } of new Bun.Transpiler({ loader: 'js' }).scanImports(code)) {
            modules.add(path);
        }
        // The bundler calls its own `__require`. Functions made by createRequire() are covered below.
        for (const [, name] of code.matchAll(/(?<![\w$.])(?:__require|require|import)\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
            modules.add(name!);
        }
        for (const [, from] of code.matchAll(/createRequire\(([^)]*)\)/g)) {
            requires.add(from!.replaceAll(/["'`]/g, '"'));
        }
    }
    return { modules: [...modules].sort(), requires: [...requires].sort() };
}

describe('the kationd bundle', () => {
    const config = bundleConfig({ appVersion: 'test', sdkVersion: 'test' });

    // Anything else would be looked up in node_modules of the directory kationd is started from
    // (and its parents), and run: a folder synced from Proton Drive, a download, the home folder.
    it('loads nothing at run time but modules built into Bun', async () => {
        const { modules, requires } = await runtimeLoads(config);
        expect(modules).toContain('crypto');
        expect(modules.filter((name) => !isBuiltin(name))).toEqual([]);
        // From "/", a missing module is only looked up in /node_modules.
        expect(requires).toEqual(['"/"']);
    }, 60_000);

    it('would be caught loading from disk without the build plugin', async () => {
        const { modules, requires } = await runtimeLoads({ ...config, plugins: [], external: ['usocket', 'x11'] });
        expect(modules.filter((name) => !isBuiltin(name))).toEqual(['usocket', 'x11']);
        expect(requires).toEqual(['"/"', 'import.meta.url']);
    }, 60_000);
});
