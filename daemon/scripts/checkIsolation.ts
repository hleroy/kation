// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Checks that the built kationd runs nothing and reads no settings from the
 * directory it is started from. People run `kationd link report.pdf` inside
 * their synced folder, whose content others can write (a shared folder).
 *
 * Usage: bun ./scripts/checkIsolation.ts path/to/kationd
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const kationd = process.argv[2];
if (!kationd) {
    console.error('Usage: bun ./scripts/checkIsolation.ts path/to/kationd');
    process.exit(2);
}

const work = await mkdtemp(path.join(tmpdir(), 'kation-isolation-'));
const planted = path.join(work, 'planted');
const loaded = (name: string) => path.join(work, `loaded-${name.replace('/', '-')}`);
const leavesTrace = (name: string) => `require('node:fs').writeFileSync(${JSON.stringify(loaded(name))}, '');\n`;

async function plant(): Promise<void> {
    await mkdir(path.join(planted, 'sub'), { recursive: true });
    await writeFile(path.join(planted, 'bunfig.toml'), 'preload = ["./preload.js"]\n');
    await writeFile(path.join(planted, 'preload.js'), leavesTrace('bunfig.toml'));
    // Read from there, the log file would be created under this folder.
    await writeFile(path.join(planted, '.env'), `XDG_STATE_HOME=${loaded('.env')}\n`);
    const usocket = path.join(planted, 'node_modules', 'usocket');
    await mkdir(usocket, { recursive: true });
    await writeFile(path.join(usocket, 'package.json'), JSON.stringify({ name: 'usocket', version: '0.0.0', main: 'index.js' }));
    await writeFile(path.join(usocket, 'index.js'), `${leavesTrace('node_modules/usocket')}module.exports = {};\n`);
}

function check(): boolean {
    const env = {
        PATH: process.env.PATH ?? '',
        HOME: path.join(work, 'home'),
        // dbus-next asks for usocket to connect to an abstract socket. Without it there is no
        // service to talk to, so `status` opens the drive itself, which writes the log file.
        DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=kation-isolation-check',
        KATION_CREDENTIALS_STORE: 'unsafe_file',
    };
    let passed = true;
    for (const [cwd, ...args] of [
        [planted, 'version'],
        [planted, 'status'],
        [path.join(planted, 'sub'), 'status'],
    ] as const) {
        const proc = Bun.spawnSync([path.resolve(kationd!), ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
        if (proc.exitCode !== 0) {
            console.error(`kationd ${args.join(' ')} failed (${proc.exitCode}): ${proc.stderr.toString().trim()}`);
            passed = false;
        }
    }
    if (!existsSync(path.join(env.HOME, '.local', 'state', 'kation', 'kationd.log'))) {
        console.error('kationd status did not open the drive: this check no longer tests what it should');
        passed = false;
    }
    for (const name of ['bunfig.toml', '.env', 'node_modules/usocket']) {
        if (existsSync(loaded(name))) {
            console.error(`kationd loaded ${name} from the directory it was started from`);
            passed = false;
        }
    }
    return passed;
}

let passed = false;
try {
    await plant();
    passed = check();
} finally {
    await rm(work, { recursive: true, force: true });
}
if (!passed) {
    process.exit(1);
}
console.log('kationd loads nothing from the directory it is started from');
